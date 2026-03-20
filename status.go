package main

import (
	"bufio"
	"context"
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/gosnmp/gosnmp"
)

var statusCache sync.Map // key: uppercase device name -> DeviceStatus
var snmpIPCache sync.Map // key: normalized MAC address -> resolved IP (string)

// normalizeMac converts any MAC address format to lowercase colon-separated form.
func normalizeMac(mac string) string {
	return strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(mac, "-", ":"), ".", ":"))
}

func debugLog(format string, args ...interface{}) {
	if appConfig.Debug {
		log.Printf("[DEBUG] "+format, args...)
	}
}

// startStatusPoller launches the background polling goroutine if enabled.
func startStatusPoller() {
	if !appConfig.EnableStatusCheck {
		debugLog("Status check disabled, poller not started")
		return
	}
	go func() {
		defer func() {
			if r := recover(); r != nil {
				log.Printf("Status poller recovered from panic: %v — restarting in 10s", r)
				time.Sleep(10 * time.Second)
				startStatusPoller()
			}
		}()
		debugLog("Poller goroutine started")
		checkAllDevices()
		ticker := time.NewTicker(time.Duration(appConfig.StatusPollInterval) * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			debugLog("Ticker fired — starting check cycle")
			checkAllDevices()
		}
	}()
	log.Printf("Status poller started (interval: %ds, protocol: %s, timeout: %ds, snmp_target: %q)",
		appConfig.StatusPollInterval, appConfig.StatusProtocol, appConfig.StatusTimeout, appConfig.SNMPTarget)
}

// checkAllDevices checks all devices in parallel and stores results in statusCache.
func checkAllDevices() {
	debugLog("Check cycle: %d device(s)", len(appData.Devices))
	var wg sync.WaitGroup
	for _, device := range appData.Devices {
		wg.Add(1)
		go func(d Device) {
			defer wg.Done()
			checkDevice(d)
		}(device)
	}
	wg.Wait()
	debugLog("Check cycle complete")
}

func checkDevice(d Device) {
	debugLog("Checking device '%s'", d.Name)
	ip := resolveDeviceIP(d)

	var statusStr string
	if ip == "" {
		statusStr = "unknown"
		debugLog("Device '%s': no IP resolved → unknown", d.Name)
	} else if pingHost(ip) {
		statusStr = "online"
		debugLog("Device '%s' (%s): online", d.Name, ip)
	} else {
		statusStr = "offline"
		debugLog("Device '%s' (%s): offline", d.Name, ip)
	}

	// Stamp last_check AFTER the ping so the time reflects check completion.
	statusCache.Store(strings.ToUpper(d.Name), DeviceStatus{
		Status:    statusStr,
		LastCheck: time.Now().Format(time.RFC3339),
		IP:        ip,
	})
}

// resolveDeviceIP returns the IP to use for status checks using the following order:
// 1. device_ip field (manually configured)
// 2. SNMP cache (previously resolved via SNMP)
// 3. ARP table
// 4. Live SNMP lookup (result is cached on success)
func resolveDeviceIP(d Device) string {
	// 1. device_ip
	if d.IP != "" {
		debugLog("Device '%s': using device_ip %s", d.Name, d.IP)
		return d.IP
	}

	normalizedMac := normalizeMac(d.Mac)

	// 2. SNMP cache
	if val, ok := snmpIPCache.Load(normalizedMac); ok {
		ip := val.(string)
		debugLog("Device '%s': SNMP cache hit → %s", d.Name, ip)
		return ip
	}
	debugLog("Device '%s': SNMP cache miss", d.Name)

	// 3. ARP table
	if ip := lookupARPByMAC(d.Mac); ip != "" {
		debugLog("Device '%s': ARP resolved to %s", d.Name, ip)
		return ip
	}
	debugLog("Device '%s': not found in ARP table", d.Name)

	// 4. Live SNMP lookup — cache result on success
	if appConfig.SNMPTarget != "" {
		debugLog("Device '%s': trying live SNMP on %s", d.Name, appConfig.SNMPTarget)
		if ip := lookupSNMPByMAC(d.Mac); ip != "" {
			debugLog("Device '%s': SNMP resolved to %s — caching", d.Name, ip)
			snmpIPCache.Store(normalizedMac, ip)
			return ip
		}
		debugLog("Device '%s': SNMP returned no result", d.Name)
	}

	log.Printf("Status: could not resolve IP for device '%s' (no device_ip, SNMP cache miss, not in ARP, SNMP returned nothing)", d.Name)
	return ""
}

// lookupSNMPByMAC queries the ipNetToMediaPhysAddress table (OID 1.3.6.1.2.1.4.22.1.2)
// on the configured SNMP target to find the IP address matching the given MAC.
func lookupSNMPByMAC(mac string) string {
	normalizedMac := normalizeMac(mac)

	g := &gosnmp.GoSNMP{
		Target:    appConfig.SNMPTarget,
		Port:      161,
		Community: appConfig.SNMPCommunity,
		Version:   gosnmp.Version2c,
		Timeout:   time.Duration(appConfig.StatusTimeout) * time.Second,
		Retries:   1,
	}
	if err := g.Connect(); err != nil {
		log.Printf("Status: SNMP connect to %s failed: %v", appConfig.SNMPTarget, err)
		return ""
	}
	defer g.Conn.Close()

	// ipNetToMediaPhysAddress — OID suffix is .ifIndex.ip1.ip2.ip3.ip4, value is MAC bytes
	const arpOID = ".1.3.6.1.2.1.4.22.1.2"
	var foundIP string
	err := g.Walk(arpOID, func(pdu gosnmp.SnmpPDU) error {
		if pdu.Type != gosnmp.OctetString {
			return nil
		}
		macBytes, ok := pdu.Value.([]byte)
		if !ok || len(macBytes) != 6 {
			return nil
		}
		entryMac := fmt.Sprintf("%02x:%02x:%02x:%02x:%02x:%02x",
			macBytes[0], macBytes[1], macBytes[2],
			macBytes[3], macBytes[4], macBytes[5])
		debugLog("SNMP ARP entry: %s → %s", pdu.Name, entryMac)
		if entryMac != normalizedMac {
			return nil
		}
		// Extract IP from OID suffix: arpOID.ifIndex.ip1.ip2.ip3.ip4
		suffix := strings.TrimPrefix(pdu.Name, arpOID+".")
		parts := strings.Split(suffix, ".")
		if len(parts) >= 5 {
			foundIP = strings.Join(parts[len(parts)-4:], ".")
		}
		return nil
	})
	if err != nil {
		log.Printf("Status: SNMP walk on %s failed: %v", appConfig.SNMPTarget, err)
		return ""
	}
	return foundIP
}

// lookupARPByMAC searches the system ARP table for the given MAC address.
func lookupARPByMAC(mac string) string {
	normalized := normalizeMac(mac)
	if runtime.GOOS == "linux" {
		if ip := lookupARPLinux(normalized); ip != "" {
			return ip
		}
	}
	return lookupARPExec(normalized)
}

// lookupARPLinux parses /proc/net/arp directly.
func lookupARPLinux(mac string) string {
	f, err := os.Open("/proc/net/arp")
	if err != nil {
		return ""
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	scanner.Scan() // skip header line
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) >= 4 && strings.ToLower(fields[3]) == mac {
			debugLog("ARP (/proc/net/arp): %s → %s", mac, fields[0])
			return fields[0]
		}
	}
	return ""
}

// lookupARPExec runs "arp -a" and parses the output (works on Windows, macOS, Linux).
func lookupARPExec(mac string) string {
	out, err := exec.Command("arp", "-a").Output()
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(out), "\n") {
		if !strings.Contains(strings.ToLower(line), mac) {
			continue
		}
		fields := strings.Fields(line)
		// Unix format: "hostname (ip) at mac ..."
		for _, f := range fields {
			if len(f) > 2 && f[0] == '(' && f[len(f)-1] == ')' {
				debugLog("ARP (arp -a): %s → %s", mac, f[1:len(f)-1])
				return f[1 : len(f)-1]
			}
		}
		// Windows format: first field is the IP address
		if len(fields) > 0 {
			if ip := net.ParseIP(fields[0]); ip != nil {
				debugLog("ARP (arp -a): %s → %s", mac, ip.String())
				return ip.String()
			}
		}
	}
	return ""
}

// pingHost checks whether an IP is reachable using the configured protocol.
func pingHost(ip string) bool {
	timeout := time.Duration(appConfig.StatusTimeout) * time.Second
	debugLog("Pinging %s (protocol: %s, timeout: %v)", ip, appConfig.StatusProtocol, timeout)
	switch appConfig.StatusProtocol {
	case "icmp":
		return pingICMP(ip, timeout)
	default:
		log.Printf("Status: unknown protocol '%s', falling back to icmp", appConfig.StatusProtocol)
		return pingICMP(ip, timeout)
	}
}

// pingICMP uses the system ping binary so no elevated Go permissions are needed.
func pingICMP(ip string, timeout time.Duration) bool {
	timeoutSec := int(timeout.Seconds())
	if timeoutSec < 1 {
		timeoutSec = 1
	}

	ctx, cancel := context.WithTimeout(context.Background(), timeout+2*time.Second)
	defer cancel()

	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.CommandContext(ctx, "ping", "-n", "1", "-w", fmt.Sprintf("%d", timeoutSec*1000), ip)
	default:
		cmd = exec.CommandContext(ctx, "ping", "-c", "1", "-W", fmt.Sprintf("%d", timeoutSec), ip)
	}
	result := cmd.Run() == nil
	debugLog("Ping %s → %v", ip, result)
	return result
}
