// Grant Portal Access - ribbon commands
// Library: this web resource. Add one command per location:
//
//  Account form  -> PortalAccess.openFromAccountForm   | Params: PrimaryControl
//  Account view  -> PortalAccess.openFromAccountGrid   | Params: SelectedControlSelectedItemIds, SelectedControl
//  Contact form  -> PortalAccess.openFromContactForm   | Params: PrimaryControl
//  Contact view  -> PortalAccess.openFromContactGrid   | Params: SelectedControlSelectedItemIds, SelectedControl
//
// Grid buttons: add an Enable Rule -> SelectionCountRule (Minimum = 1).
var PortalAccess = window.PortalAccess || {};

(function () {
    "use strict";

    var WEB_RESOURCE = "array_PortalUserInvitationDialog";
    var MAX_RECORDS = 50;

    function clean(id) { return (id || "").replace(/[{}]/g, "").toLowerCase(); }

    function open(mode, ids, onClose) {
        ids = (ids || []).map(clean).filter(Boolean);

        if (!ids.length) {
            Xrm.Navigation.openAlertDialog({ text: "Select at least one record." });
            return;
        }
        if (ids.length > MAX_RECORDS) {
            Xrm.Navigation.openAlertDialog({ text: "Select up to " + MAX_RECORDS + " records at a time. You selected " + ids.length + "." });
            return;
        }

        Xrm.Navigation.navigateTo(
            {
                pageType: "webresource",
                webresourceName: WEB_RESOURCE,
                data: JSON.stringify({ mode: mode, ids: ids })
            },
            {
                target: 2,
                position: 1,
                width: { value: 640, unit: "px" },
                height: { value: 700, unit: "px" },
                title: "Grant portal access"
            }
        ).then(onClose, function (err) {
            Xrm.Navigation.openErrorDialog({ message: err.message });
        });
    }

    function fromForm(mode, primaryControl) {
        var formContext = primaryControl;
        var id = clean(formContext.data.entity.getId());
        if (!id) {
            Xrm.Navigation.openAlertDialog({ text: "Save the record before granting portal access." });
            return;
        }
        open(mode, [id], function () { formContext.data.refresh(false); });
    }

    function fromGrid(mode, selectedIds, selectedControl) {
        open(mode, selectedIds, function () {
            if (selectedControl && selectedControl.refresh) selectedControl.refresh();
        });
    }

    PortalAccess.openFromAccountForm = function (primaryControl) { fromForm("account", primaryControl); };
    PortalAccess.openFromContactForm = function (primaryControl) { fromForm("contact", primaryControl); };
    PortalAccess.openFromAccountGrid = function (selectedIds, selectedControl) { fromGrid("account", selectedIds, selectedControl); };
    PortalAccess.openFromContactGrid = function (selectedIds, selectedControl) { fromGrid("contact", selectedIds, selectedControl); };
})();
