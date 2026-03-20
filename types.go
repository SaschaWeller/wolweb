package main

//HTTPResponseObject Data structure for sending the API call status
type HTTPResponseObject struct {
	Success     bool   `json:"success"`
	Message     string `json:"message"`
	ErrorObject error  `json:"error"`
}

// Device represents a Computer Object
type Device struct {
	Name        string `json:"name"`
	Mac         string `json:"mac"`
	BroadcastIP string `json:"ip"`
	Interface   string `json:"interface"`
	IP          string `json:"device_ip"`
	Note        string `json:"note"`
}

// DeviceStatus holds the online/offline state of a device
type DeviceStatus struct {
	Status    string `json:"status"`      // "online" | "offline" | "unknown"
	LastCheck string `json:"last_check"`
	IP        string `json:"resolved_ip"`
}

// AppData is list of Computer objects defined in JSON config file
type AppData struct {
	Devices []Device `json:"devices"`
}

// AppConfig represents a configuration object to initialize this application
type AppConfig struct {
	Host     string `json:"host" env:"WOLWEBHOST" env-default:"0.0.0.0"`
	Port     int    `json:"port" env:"WOLWEBPORT" env-default:"8089"`
	VDir     string `json:"vdir" env:"WOLWEBVDIR" env-default:"/wolweb"`
	BCastIP  string `json:"bcastip" env:"WOLWEBBCASTIP" env-default:"192.168.1.255:9"`
	ReadOnly            bool   `json:"read_only" env:"WOLWEBREADONLY" env-default:"false"`
	HideAPIDocs         bool   `json:"hide_api_docs" env:"WOLWEBHIDEAPIDOCS" env-default:"false"`
	EnableStatusCheck   bool   `json:"enable_status_check" env:"WOLWEBENABLESTATUSCHECK" env-default:"false"`
	StatusProtocol      string `json:"status_protocol" env:"WOLWEBSTATUSPROTOCOL" env-default:"icmp"`
	StatusPollInterval  int    `json:"status_poll_interval" env:"WOLWEBSTATUSPOLLINTERVAL" env-default:"60"`
	StatusTimeout       int    `json:"status_timeout" env:"WOLWEBSTATUSTIMEOUT" env-default:"30"`
	SNMPCommunity       string `json:"snmp_community" env:"WOLWEBSNMPCOMMUNITY" env-default:"public"`
	SNMPTarget          string `json:"snmp_target" env:"WOLWEBSNMPTARGET" env-default:""`
	Debug               bool   `json:"debug" env:"WOLWEBDEBUG" env-default:"false"`
}
