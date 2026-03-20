var readOnly = false;
var enableStatusCheck = false;
var statusPollInterval = 60;
var statusCache = {};      // deviceName -> "online" | "offline" | "unknown"
var hiddenColumns = {};    // css class -> true (hidden)
var columnOrder = [];      // ordered array of css class names for hideable columns
var statusPollTimer = null;

$(document).ready(function () {
    readOnly = (document.querySelector("body").dataset.readOnly == "true");
    enableStatusCheck = (window.enableStatusCheck === true);
    statusPollInterval = window.statusPollInterval || 60;
    loadHiddenColumns();

    jQuery.showToast = function (data) {
        var timeout = 3000;
        if (!data.success || data.error != null) {
            Toast.create({ title: "Error", message: data.message || "Something went wrong", status: TOAST_STATUS.DANGER, timeout: timeout });
        } else {
            Toast.create({ title: "Success", message: data.message, status: TOAST_STATUS.SUCCESS, timeout: timeout });
        }
    };

    jQuery.wakeUpDeviceByName = function (deviceName) {
        $.ajax({
            type: "GET",
            url: (vDir == "/" ? "" : vDir) + "/wake/" + deviceName,
            contentType: "application/json; charset=utf-8",
            dataType: "json",
            success: function (data) { $.showToast(data.responseJSON ?? data); },
            error:   function (data)  { $.showToast(data.responseJSON ?? data); console.error(data); }
        });
    };

    getAppData();
});

// ── Column visibility ──────────────────────────────────────────────────────────

function loadHiddenColumns() {
    try { hiddenColumns = JSON.parse(localStorage.getItem("wolweb-hidden-columns") || "{}"); }
    catch (e) { hiddenColumns = {}; }
}
function saveHiddenColumns() {
    localStorage.setItem("wolweb-hidden-columns", JSON.stringify(hiddenColumns));
}
function applyColumnVisibility() {
    Object.keys(hiddenColumns).forEach(function (cls) {
        $("." + cls).toggle(!hiddenColumns[cls]);
    });
}

// ── Column order ───────────────────────────────────────────────────────────────

function loadColumnOrder(availableKeys) {
    try {
        var saved = JSON.parse(localStorage.getItem("wolweb-column-order") || "[]");
        // Keep only keys that still exist, then append any new ones at the end
        columnOrder = saved.filter(function (k) { return availableKeys.indexOf(k) >= 0; });
        availableKeys.forEach(function (k) { if (columnOrder.indexOf(k) < 0) columnOrder.push(k); });
    } catch (e) {
        columnOrder = availableKeys.slice();
    }
}
function saveColumnOrder() {
    localStorage.setItem("wolweb-column-order", JSON.stringify(columnOrder));
}
function updateColumnOrderFromDOM() {
    columnOrder = $("#column-selector-menu li[data-col-css]").map(function () {
        return $(this).data("col-css");
    }).get();
    saveColumnOrder();
}

// ── Column selector dropdown ───────────────────────────────────────────────────
// fixedColumns: [{css, title}] — shown at top, no reorder buttons
// orderedColumns: [{css, title}] — shown below, with reorder buttons

function buildColumnSelector(fixedColumns, orderedColumns) {
    var $menu = $("#column-selector-menu").empty();

    // Fixed-position columns (visibility only, no reorder)
    fixedColumns.forEach(function (col) {
        var visible = !hiddenColumns[col.css];
        var $li = $("<li>");
        $li.append(
            $("<label>").attr({ class: "dropdown-item d-flex align-items-center gap-2 col-selector-item" }).append(
                $("<input>").attr({ type: "checkbox", class: "form-check-input flex-shrink-0", checked: visible })
                    .on("change", function () {
                        hiddenColumns[col.css] = !this.checked;
                        saveHiddenColumns();
                        applyColumnVisibility();
                    }),
                $("<span>").addClass("flex-grow-1").text(col.title),
                $("<i>").attr({ class: "bi bi-pin-angle-fill text-muted", title: "Fixed position", style: "font-size:11px;flex-shrink:0;" })
            )
        );
        $menu.append($li);
    });

    if (fixedColumns.length > 0 && orderedColumns.length > 0) {
        $menu.append($("<li>").append($("<hr>").addClass("dropdown-divider my-1")));
    }

    // Orderable columns (with reorder buttons)
    orderedColumns.forEach(function (col) {
        var visible = !hiddenColumns[col.css];
        var $li = $("<li>").attr({ "data-col-css": col.css });

        var $moveUp = $("<button>")
            .attr({ class: "btn p-0 col-reorder-btn", title: "Move up", type: "button" })
            .html('<i class="bi bi-caret-up-fill"></i>')
            .on("click", function (e) {
                e.stopPropagation();
                var $prev = $li.prev("li[data-col-css]");
                if ($prev.length) { $li.insertBefore($prev); updateColumnOrderFromDOM(); reRenderGrid(); }
            });

        var $moveDown = $("<button>")
            .attr({ class: "btn p-0 col-reorder-btn", title: "Move down", type: "button" })
            .html('<i class="bi bi-caret-down-fill"></i>')
            .on("click", function (e) {
                e.stopPropagation();
                var $next = $li.next("li[data-col-css]");
                if ($next.length) { $li.insertAfter($next); updateColumnOrderFromDOM(); reRenderGrid(); }
            });

        $li.append(
            $("<label>").attr({ class: "dropdown-item d-flex align-items-center gap-2 col-selector-item" }).append(
                $("<input>").attr({ type: "checkbox", class: "form-check-input flex-shrink-0", checked: visible })
                    .on("change", function () {
                        hiddenColumns[col.css] = !this.checked;
                        saveHiddenColumns();
                        applyColumnVisibility();
                    }),
                $("<span>").addClass("flex-grow-1").text(col.title),
                $("<span>").addClass("d-flex flex-column gap-0 ms-1").append($moveUp, $moveDown)
            )
        );
        $menu.append($li);
    });
}

// ── Status polling ─────────────────────────────────────────────────────────────

function pollDeviceStatuses() {
    if (!enableStatusCheck || !appData || !appData.devices) return;
    appData.devices.forEach(function (device) {
        $.getJSON((vDir == "/" ? "" : vDir) + "/status/" + encodeURIComponent(device.name), function (data) {
            var status = data.status || "unknown";
            var resolvedIP = data.resolved_ip || "";
            statusCache[device.name] = status;
            statusCache[device.name + "__ip"] = resolvedIP;

            // Update status indicator
            $('[data-device-status="' + device.name + '"]')
                .removeClass("status-online status-offline status-unknown")
                .addClass("status-" + status).attr("title", status);
            $('[data-device-status-label="' + device.name + '"]').text(status);

            // Update Device IP cell with resolved IP when no static IP is configured
            if (resolvedIP) {
                $('[data-device-ip="' + device.name + '"]').each(function () {
                    // Only overwrite if the cell is currently showing the resolved IP (no static override)
                    if (!$(this).data("static-ip")) {
                        $(this).text(resolvedIP);
                    }
                });
            }
        }).fail(function () { statusCache[device.name] = "unknown"; });
    });
}

// ── Data loading ───────────────────────────────────────────────────────────────

function getAppData() {
    $.getJSON((vDir == "/" ? "" : vDir) + "/data/get", function (data) {
        window.appData = data;
        if (!appData.devices) appData.devices = [];
        renderData();
    }).fail(function (data) {
        data.error = true; data.message = "Unable to retrieve device data!";
        $.showToast(data); console.error(data);
    });
}

// ── Grid re-render (called on column reorder) ──────────────────────────────────

function reRenderGrid() {
    if (statusPollTimer) { clearInterval(statusPollTimer); statusPollTimer = null; }
    if ($("#GridDevices").data("JSGrid")) { $("#GridDevices").jsGrid("destroy"); }
    renderData();
}

// ── Main grid render ───────────────────────────────────────────────────────────

function renderData() {
    // Register custom BS control field (safe to overwrite)
    var BSControl = function (config) { jsGrid.ControlField.call(this, config); };
    BSControl.prototype = new jsGrid.ControlField({});
    jsGrid.fields.bscontrol = BSControl;

    // ── Status field (fixed first, not in columnMap) ────────────────────────────
    var statusField = null;
    if (enableStatusCheck) {
        statusField = {
            name: "status", title: "Status", type: "text", width: 100,
            css: "col-status", headercss: "col-status",
            editing: false, inserting: false, filtering: false,
            itemTemplate: function (value, item) {
                var s = statusCache[item.name] || "unknown";
                return $("<span>").attr({ class: "status-indicator" }).append(
                    $("<span>").attr({ class: "status-dot status-" + s, "data-device-status": item.name, title: s }),
                    $("<span>").attr({ class: "status-label", "data-device-status-label": item.name }).text(s)
                );
            },
            editTemplate:   function () { return ""; },
            insertTemplate: function () { return ""; },
            filterTemplate: function () { return ""; }
        };
    }

    // ── Build column map (all hideable+orderable columns) ──
    var columnMap = {};

    columnMap["col-mac"] = {
        title: "MAC Address",
        field: {
            name: "mac", title: "MAC Address", type: "text", width: null,
            css: "col-mac", headercss: "col-mac",
            validate: { validator: "pattern", param: /^[0-9a-f]{1,2}([\.:-])(?:[0-9a-f]{1,2}\1){4}[0-9a-f]{1,2}$/gmi, message: "MAC Address is a required field." }
        }
    };

    columnMap["col-ip"] = {
        title: "Broadcast IP",
        field: {
            name: "ip", title: "Broadcast IP", type: "text", width: null,
            css: "col-ip", headercss: "col-ip",
            validate: { validator: "required", message: "Broadcast IP Address is a required field." },
            insertTemplate: function () { var $r = jsGrid.fields.text.prototype.insertTemplate.call(this); $r.val(bCastIP); return $r; }
        }
    };

    columnMap["col-device-ip"] = {
        title: "Device IP",
        field: {
            name: "device_ip", title: "Device IP", type: "text", width: null,
            css: "col-device-ip", headercss: "col-device-ip",
            editing: false, inserting: true, filtering: false,
            itemTemplate: function (value, item) {
                // Show static device_ip if configured, otherwise fall back to resolved IP from status cache
                var staticIP = value || "";
                var ip = staticIP || statusCache[item.name + "__ip"] || "";
                return $("<span>")
                    .attr({ "data-device-ip": item.name })
                    .data("static-ip", staticIP ? true : false)
                    .text(ip);
            },
            editTemplate:   function () { return ""; },
            insertTemplate: function () { var $r = jsGrid.fields.text.prototype.insertTemplate.call(this); $r.val(""); return $r; },
            filterTemplate: function () { return ""; }
        }
    };

    columnMap["col-interface"] = {
        title: "Interface",
        field: {
            name: "interface", title: "Interface", type: "text", width: null,
            css: "col-interface", headercss: "col-interface",
            insertTemplate: function () { var $r = jsGrid.fields.text.prototype.insertTemplate.call(this); $r.val(""); return $r; }
        }
    };

    columnMap["col-note"] = {
        title: "Note",
        field: {
            name: "note", title: "Note", type: "text", width: null,
            css: "col-note", headercss: "col-note",
            itemTemplate: function (value) { return value || ""; },
            insertTemplate: function () { var $r = jsGrid.fields.text.prototype.insertTemplate.call(this); $r.val(""); return $r; }
        }
    };

    columnMap["col-control"] = {
        title: "Edit / Delete",
        field: {
            name: "control", type: "bscontrol", width: 100,
            css: "col-control", headercss: "col-control",
            editButton: false, deleteButton: false, modeSwitchButton: true,

            itemTemplate: function (value, item) {
                var grid = this._grid;
                var $editBtn = $("<button>").attr({ class: "btn btn-outline-secondary btn-xs", role: "button", title: jsGrid.fields.control.prototype.editButtonTooltip, disabled: true })
                    .append($("<i>").attr({ class: "bi bi-pencil-square", style: "position:relative;top:-3px;left:-6px;" }));
                var $delBtn  = $("<button>").attr({ class: "btn btn-outline-secondary btn-xs", role: "button", title: jsGrid.fields.control.prototype.deleteButtonTooltip, disabled: true })
                    .append($("<i>").attr({ class: "bi bi-trash-fill", style: "position:relative;top:-3px;left:-6px;" }));

                if (!readOnly) {
                    $editBtn.attr({ class: "btn btn-outline-warning btn-xs", disabled: false })
                        .click(function (e) { grid.editItem(item); e.stopPropagation(); });
                    $delBtn.attr({ class: "btn btn-outline-danger btn-xs", disabled: false })
                        .click(function (e) { grid.deleteItem(item); e.stopPropagation(); });
                }
                return $("<div>").attr({ class: "btn-group" }).append($editBtn, $delBtn);
            },

            editTemplate: function () {
                var grid = this._grid;
                var $ok  = $("<button>").attr({ class: "btn btn-outline-success btn-xs", role: "button", title: jsGrid.fields.control.prototype.updateButtonTooltip })
                    .click(function (e) { grid.updateItem(); e.stopPropagation(); })
                    .append($("<i>").attr({ class: "bi bi-check-lg", style: "position:relative;top:-3px;left:-6px;" }));
                var $cancel = $("<button>").attr({ class: "btn btn-outline-secondary btn-xs", role: "button", title: jsGrid.fields.control.prototype.cancelEditButtonTooltip })
                    .click(function (e) { grid.cancelEdit(); e.stopPropagation(); })
                    .append($("<i>").attr({ class: "bi bi-x-lg", style: "position:relative;top:-3px;left:-6px;" }));
                return $("<div>").attr({ class: "btn-group" }).append($ok, $cancel);
            },

            insertTemplate: function () {
                var grid = this._grid;
                var isInserting = grid.inserting;
                var $save = $("<button>").attr({ class: "btn btn-outline-primary btn-xs", role: "button", title: "Save device to list" })
                    .click(function (e) { grid.insertItem().done(function () { grid.clearInsert(); }); e.stopPropagation(); })
                    .append($("<i>").attr({ class: "bi bi-save", style: "position:relative;top:-3px;left:-6px;" }));
                var $cancel = $("<button>").attr({ class: "btn btn-outline-secondary btn-xs", role: "button", title: "Cancel insert" })
                    .click(function (e) { grid.clearInsert(); isInserting = false; grid.option("inserting", isInserting); e.stopPropagation(); })
                    .append($("<i>").attr({ class: "bi bi-x-lg", style: "position:relative;top:-3px;left:-6px;" }));
                return $("<div>").attr({ class: "btn-group" }).append($save, $cancel);
            },

            filterTemplate: function () {
                var grid = this._grid;
                var $filter = $("<button>").attr({ class: "btn btn-outline-info btn-xs", role: "button", title: "Apply filter" })
                    .click(function (e) { grid.loadData(); e.stopPropagation(); })
                    .append($("<i>").attr({ class: "bi bi-filter", style: "position:relative;top:-3px;left:-6px;" }));
                var $clear = $("<button>").attr({ class: "btn btn-outline-secondary btn-xs", role: "button", title: "Clear filter" })
                    .click(function (e) { grid.clearFilter(); isFiltering = false; grid.option("filtering", isFiltering); e.stopPropagation(); })
                    .append($("<i>").attr({ class: "bi bi-x-lg", style: "position:relative;top:-3px;left:-6px;" }));
                return $("<div>").attr({ class: "btn-group" }).append($filter, $clear);
            }
        }
    };

    // ── Build gridFields in stored order ──
    var availableKeys = Object.keys(columnMap);
    loadColumnOrder(availableKeys);

    // Fixed first: Status (not in menu reorder, not in columnMap)
    var gridFields = [];
    if (enableStatusCheck && statusField) {
        gridFields.push(statusField);
    }

    // Fixed second: Device name (not in menu)
    gridFields.push({
        name: "name", title: "Device", type: "text", width: null,
        css: "col-name", headercss: "col-name",
        validate: { validator: "required", message: "Device name is a required field." }
    });

    // Ordered hideable columns
    columnOrder.forEach(function (css) {
        if (columnMap[css]) gridFields.push(columnMap[css].field);
    });

    // Fixed last: Action (not in menu)
    gridFields.push({
        name: "command", title: "Action", type: "control", width: 125,
        css: "col-command", headercss: "col-command",
        modeSwitchButton: false,
        itemTemplate: function (value, item) {
            return $("<button>").attr({ class: "btn btn-primary btn-sm", type: "button", title: "Send magic packet" })
                .append($("<i>").attr({ class: "bi bi-lightning-fill", style: "margin-right:6px" }))
                .append("WAKE-UP")
                .on("click", function () { $.wakeUpDeviceByName(item.name); });
        },
        editTemplate:   function () { return ""; },
        insertTemplate: function () { return ""; },
        filterTemplate: function () { return ""; }
    });

    // ── jsGrid init ────────────────────────────────────────────────────────────
    $("#GridDevices").jsGrid({
        height: "auto", width: "100%",
        filtering: false, inserting: false, editing: true,
        selecting: true, sorting: false, paging: true,
        rowClick: function (args) { args.cancel = true; },
        noDataContent: "No devices found",
        pageIndex: 1, pageSize: 15,
        pagerFormat: "Pages: {prev} {pages} {next}",
        confirmDeleting: true,
        deleteConfirm: "Are you sure you want to delete this device?",
        data: appData.devices,
        fields: gridFields,
        controller: {
            data: appData.devices,
            loadData: function (filter) {
                return $.grep(this.data, function (item) {
                    for (var field in filter) { if (filter[field]) {
                        if (item[field] && item[field].toUpperCase().indexOf(filter[field].toUpperCase()) >= 0) return true;
                    }}
                    return Object.keys(filter).every(function (f) { return !filter[f]; });
                });
            }
        },
        updateOnResize: true,
        onRefreshed: function () { performBSPagerConversion(); applyColumnVisibility(); },
        onItemInserted: saveInsertedData,
        onItemDeleted:  saveAppData,
        onItemUpdated:  saveAppData
    });

    // Build selector: fixed columns (status) at top, orderable below
    var fixedCols = enableStatusCheck ? [{ css: "col-status", title: "Status" }] : [];
    var hideableCols = columnOrder.map(function (css) {
        return { css: css, title: columnMap[css] ? columnMap[css].title : css };
    });
    buildColumnSelector(fixedCols, hideableCols);
    applyColumnVisibility();

    // Status polling — start only once
    if (enableStatusCheck && !statusPollTimer) {
        pollDeviceStatuses();
        statusPollTimer = setInterval(pollDeviceStatuses, statusPollInterval * 1000);
    }

    // Toolbar buttons
    $("#device-insert-btn").off("click").on("click", function () { $("#GridDevices").jsGrid("option", "inserting", true); });
    $("#device-filter-btn").off("click").on("click", function () { $("#GridDevices").jsGrid("option", "filtering", true); });
}

// ── Data persistence ───────────────────────────────────────────────────────────

function saveAppData() {
    $.ajax({
        type: "POST", url: (vDir == "/" ? "" : vDir) + "/data/save",
        contentType: "application/json; charset=utf-8", dataType: "json",
        data: JSON.stringify(appData),
        success: function (data) { $.showToast(data); console.log(data); },
        error:   function (data) { $.showToast(data); console.error(data); }
    });
}
function saveInsertedData() { saveAppData(); $(".device-insert-button").click(); }

// ── Bootstrap pager conversion ─────────────────────────────────────────────────

function getTextNodesIn(node, includeWhitespaceNodes) {
    var textNodes = [], whitespace = /^\s*$/;
    function getTextNodes(node) {
        if (node.nodeType == 3) {
            if (includeWhitespaceNodes || !whitespace.test(node.nodeValue)) textNodes.push(node);
        } else {
            for (var i = 0; i < node.childNodes.length; i++) getTextNodes(node.childNodes[i]);
        }
    }
    getTextNodes(node);
    return textNodes;
}

function performBSPagerConversion() {
    $(".jsgrid-pager").wrap("<ul class='pagination'>").contents().unwrap();
    $(".pagination").wrap("<nav>");
    $(".pagination").children().each(function (i, v) { $(v).wrap('<li class="page-item">'); });
    $(".pagination a").addClass("page-link");
    $(".jsgrid-pager-nav-inactive-button").addClass("disabled").parent().addClass("disabled");
    $(".page-item .jsgrid-pager-current-page").parent().addClass("active").contents().wrap("<a class='page-link'>");

    var textNodeParent = ".pagination";
    getTextNodesIn($(textNodeParent)[0]).forEach(function (node) {
        if ($(node).parent().is(textNodeParent)) $(node).wrap("<span>");
    });
    $(".pagination > span").each(function (i, v) {
        var dest = ".jsgrid-pager-container nav";
        if (i >= 1) $(v).detach().appendTo(dest); else $(v).detach().prependTo(dest);
    });
}
