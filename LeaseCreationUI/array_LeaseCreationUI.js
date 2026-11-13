//---------------------------------  Debug / logging control  -------------------------------------//
// Production: silence verbose console.log/info/debug noise. Real errors and warnings are kept.
// Re-enable verbose logs at runtime with:  window.LEASE_DEBUG = true
(function () {
  var _origLog =
    window.console && console.log ? console.log.bind(console) : function () {};
  window.LEASE_DEBUG = false;
  if (window.console) {
    var _noop = function () {
      if (window.LEASE_DEBUG) _origLog.apply(null, arguments);
    };
    console.log = _noop;
    console.info = _noop;
    console.debug = _noop;
  }
  // Autofill flow timing tracer - disabled. Kept as no-ops so the existing
  // _flowReset()/_flowLog() call sites stay valid without printing anything.
  window._flowReset = function () {};
  window._flowLog = function () {};
})();

//---------------------------------  Global variables  -------------------------------------------//
let units = [];
let recurringCharges = [];
let leaseDiscounts = [];
let editingDiscountId = null;
let deposits = [];
let XrmContext = window.parent.Xrm || window.Xrm;
let currentTenantType = "account";
let tenantSearchTimeout = null;
let propertySearchTimeout = null;
let currentTenantPage = 1;
let hasMoreTenants = true;
let isLoadingTenants = false;
let currentSearchTerm = "";
let lastSelectedTenantName = "";
let allTenantResults = [];
let currentStage = 1;
let completedStages = [];
// Highest stage the user has reached. A forward jump to stage T is only allowed
// once every prior stage (1..T-1) has been visited, i.e. maxVisitedStage >= T - 1.
let maxVisitedStage = 1;
let unitSearchTimeout = null;
let allUnitResults = [];
let tempSelectedUnits = [];
let chargesLoadedInitially = false;
let deleteConfirmCallback = null;
let deletedChargeIds = []; // Track deleted charges to prevent reload
let originalChargesFromDataverse = []; // Store original charges loaded from Dataverse
let chargesToDelete = [];
let totalUnitsAreaValue = 0;
let collateralRules = [];
let collateralConfigs = [];
let currentRuleChargeTypes = [];

//----------------------------------------  UTILITY FUNCTIONS  -----------------------------------//

// Track charges to delete on save (only existing ones)
//format date
function formatDateDMY(dateStr) {
  if (!dateStr) return "-";

  // Handles YYYY-MM-DD or ISO strings
  const date = new Date(dateStr);
  if (isNaN(date)) return dateStr;

  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = date.getFullYear();

  return `${dd}-${mm}-${yyyy}`;
}

//  Format Date for Input Field (YYYY-MM-DD)
function formatDateForInput(date) {
  if (!date || isNaN(date.getTime())) return "";

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

// FormatDate Display
function formatDateDisplay(date) {
  if (!date || isNaN(date.getTime())) return "-";
  try {
    const options = { year: "numeric", month: "short", day: "numeric" };
    return date.toLocaleDateString("en-US", options);
  } catch (error) {
    console.error("Error formatting date:", error);
    return "-";
  }
}

// Show notification
function showNotification(message, type = "info") {
  const colors = {
    success: "#48bb78",
    error: "#f56565",
    warning: "#ed8936",
    info: "#667eea",
  };

  const notification = document.createElement("div");
  notification.className = "notification";
  // Inline styling so the toast renders correctly even if the external CSS is
  // cached/unavailable inside the D365 iframe (belt-and-suspenders vs CSS).
  notification.style.cssText =
    "position:fixed;right:20px;top:20px;z-index:2147483647;" +
    "min-width:240px;max-width:380px;padding:13px 18px;border-radius:10px;" +
    "font-size:13px;font-weight:600;line-height:1.4;color:#fff;" +
    "box-shadow:0 10px 30px rgba(17,24,39,0.18),0 2px 6px rgba(17,24,39,0.12);" +
    "word-break:break-word;animation:toastIn 0.28s cubic-bezier(0.21,1.02,0.73,1) both;";
  notification.style.background = colors[type];
  notification.textContent = message;
  document.body.appendChild(notification);

  // Stack multiple toasts top-right so they don't overlap.
  const restack = () => {
    let top = 20;
    document.querySelectorAll(".notification").forEach((n) => {
      n.style.top = top + "px";
      top += n.offsetHeight + 12;
    });
  };
  restack();

  setTimeout(() => {
    notification.style.animation = "slideOut 0.3s ease-out";
    setTimeout(() => {
      notification.remove();
      restack();
    }, 300);
  }, 3000);
}

// Show loading overlay
function showLoadingOverlay(message = "Loading...") {
  let overlay = document.getElementById("savingOverlay");

  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "savingOverlay";
    overlay.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(243, 245, 249, 0.82);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 999999;
                backdrop-filter: blur(3px);
            `;

    overlay.innerHTML = `
                <div style="text-align: center;">
                    <div class="loader" style="
                        width: 46px;
                        height: 46px;
                        border: 3px solid #E5E7EB;
                        border-top-color: var(--blue);
                        border-radius: 50%;
                        animation: spin 0.8s linear infinite;
                        margin: 0 auto 22px;
                    "></div>
                    <div id="loadingMessage" style="
                        font-size: 16px;
                        font-weight: 700;
                        color: #374151;
                        line-height: 1.4;
                    ">${message}</div>
                    <div style="
                        margin-top: 6px;
                        font-size: 13px;
                        color: #9CA3AF;
                        font-weight: 500;
                    ">Please wait while we fetch your data</div>
                </div>
            `;

    document.body.appendChild(overlay);
  } else {
    overlay.style.display = "flex";
    const messageElem = document.getElementById("loadingMessage");
    if (messageElem) {
      messageElem.textContent = message;
    }
  }
}

// Hide loading overlay
function hideLoadingOverlay() {
  const overlay = document.getElementById("savingOverlay");
  if (overlay) {
    overlay.style.display = "none";
  }
}

//Disable All Activity
// Non-blocking progress for PDF autofill: the user can read the (already
// opened) PDF preview while extraction runs; the form area is made read-only
// (dimmed + non-interactive) but the screen is NOT locked. The loader is
// centered over the LEFT form container (the active stage) - clean spinner +
// two-line text, no background box. Inline styles keep this robust inside the
// D365 iframe regardless of external CSS load order.
let _autofillReposTimer = null;

function _positionAutofillLoader() {
  const bar = document.getElementById("autofillProgressBar");
  if (!bar) return;
  // Anchor to #lpvFormCol - the column the PDF preview wraps the form into. It is
  // exactly the form region (the PDF pane is its SIBLING, so it's excluded on both
  // the wide side-by-side layout AND the <=900px stacked layout where the pane
  // docks below), and it is itself the scroll container (overflow-y:auto), so its
  // viewport rect stays stable while its content scrolls - no more drift on scroll
  // and no overlay over the PDF viewer. Fall back to formBody / active stage when
  // the PDF pane hasn't mounted yet.
  const target =
    document.getElementById("lpvFormCol") ||
    document.getElementById("formBody") ||
    document.querySelector(".stage-content.active");
  if (!target) return;
  const r = target.getBoundingClientRect();
  bar.style.left = r.left + "px";
  bar.style.top = r.top + "px";
  bar.style.width = r.width + "px";
  bar.style.height = r.height + "px";
}

function showAutofillProgress(
  message = "Extracting data from your document...",
) {
  // Lock the form region only - leave the PDF preview pane fully interactive.
  // `inert` removes the form from the tab order AND blocks pointer/keyboard input,
  // so the user can't Tab into fields while extraction runs (pointer-events alone
  // does not block keyboard focus). Dim for the visual "busy" cue.
  document.querySelectorAll(".stage-content").forEach((el) => {
    el.style.pointerEvents = "none";
    el.style.opacity = "0.85";
    el.setAttribute("inert", "");
  });
  // Also mark the wrapping form column inert (covers anything outside the active
  // stage, e.g. the upload bar) without touching the PDF pane, which is its sibling.
  const _formCol = document.getElementById("lpvFormCol");
  if (_formCol) _formCol.setAttribute("inert", "");
  // Lock the action regions that live OUTSIDE the form column (header Reset
  // button, the step rail, and the footer nav) so Reset / Back / Next / Save
  // can't be clicked mid-extraction. The PDF pane is untouched.
  [".form-header", ".stage-progress", ".stage-navigation"].forEach((sel) => {
    const el = document.querySelector(sel);
    if (el) {
      el.setAttribute("inert", "");
      el.style.opacity = "0.85";
    }
  });
  document.body.classList.add("autofill-busy");

  let bar = document.getElementById("autofillProgressBar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "autofillProgressBar";
    // Light frosted overlay over the left form region - blurs the form behind
    // so the loader reads cleanly, while staying on-theme with the app bg.
    bar.style.cssText = `
      position: fixed; z-index: 8500;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      text-align: center; pointer-events: none;
      background: rgba(243,245,249,0.55);
      -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px);
      font-family: 'Inter','Segoe UI',system-ui,sans-serif;
    `;
    bar.innerHTML = `
      <span style="width:42px;height:42px;border-radius:50%;border:3px solid #E5E7EB;border-top-color:#1C6BD4;animation:spin 0.8s linear infinite;display:inline-block;margin-bottom:20px;"></span>
      <span id="autofillProgressMsg" style="font-size:15px;font-weight:600;color:#4B5563;line-height:1.4;"></span>
      <span style="margin-top:6px;font-size:13px;font-weight:500;color:#9CA3AF;">Please wait while we autofill your form...</span>
    `;
    document.body.appendChild(bar);
  }
  bar.style.display = "flex";
  const msgEl = document.getElementById("autofillProgressMsg");
  if (msgEl) msgEl.textContent = message;

  // Track the left region as the PDF pane opens / the user resizes it.
  _positionAutofillLoader();
  if (_autofillReposTimer) clearInterval(_autofillReposTimer);
  _autofillReposTimer = setInterval(_positionAutofillLoader, 250);
  window.addEventListener("resize", _positionAutofillLoader);
}

function hideAutofillProgress() {
  document.querySelectorAll(".stage-content").forEach((el) => {
    el.style.pointerEvents = "";
    el.style.opacity = "";
    el.removeAttribute("inert");
  });
  const _formCol = document.getElementById("lpvFormCol");
  if (_formCol) _formCol.removeAttribute("inert");
  [".form-header", ".stage-progress", ".stage-navigation"].forEach((sel) => {
    const el = document.querySelector(sel);
    if (el) {
      el.removeAttribute("inert");
      el.style.opacity = "";
    }
  });
  document.body.classList.remove("autofill-busy");
  if (_autofillReposTimer) {
    clearInterval(_autofillReposTimer);
    _autofillReposTimer = null;
  }
  window.removeEventListener("resize", _positionAutofillLoader);
  const bar = document.getElementById("autofillProgressBar");
  if (bar) bar.style.display = "none";
}

function disableAllInteractions() {
  document
    .querySelectorAll("button, input, select, textarea")
    .forEach((elem) => {
      elem.disabled = true;
      elem.style.pointerEvents = "none";
      elem.style.opacity = "0.5";
    });

  const overlay = document.createElement("div");
  overlay.id = "interactionBlocker";
  overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            z-index: 999998;
            cursor: not-allowed;
        `;
  document.body.appendChild(overlay);
}

//Enable All Interaction
function enableAllInteractions() {
  document
    .querySelectorAll("button, input, select, textarea")
    .forEach((elem) => {
      elem.disabled = false;
      elem.style.pointerEvents = "auto";
      elem.style.opacity = "1";
    });

  const overlay = document.getElementById("interactionBlocker");
  if (overlay) {
    overlay.remove();
  }
}

// Ensure these helper functions exist in your code
function removeAllNavigationBlockers() {
  console.log(" Removing navigation blockers...");
  window.onbeforeunload = null;
  if (window.parent) {
    window.parent.onbeforeunload = null;
  }
  window.allowNavigation = true;
  console.log(" Navigation blockers removed");
}

// Clear Dynamic Navigation
function clearDynamicsNavigationGuards() {
  try {
    // Method 1: Clear window handlers
    window.onbeforeunload = null;
    if (window.parent) {
      window.parent.onbeforeunload = null;
    }

    // Method 2: Clear Dynamics Page Manager
    if (window.parent && window.parent.Mscrm) {
      const pageManager = window.parent.Mscrm.PageManager?.get_instance?.();
      if (pageManager && pageManager.clearAllNavigationHandlers) {
        pageManager.clearAllNavigationHandlers();
      }
    }

    // Method 3: Clear shell dirty flag
    if (window.parent && window.parent._shell) {
      window.parent._shell.isDirty = false;
    }

    // Method 4: Set navigation flags
    window.allowNavigation = true;
    if (window.parent) {
      window.parent.allowNavigation = true;
    }

    console.log(" Navigation guards cleared successfully");
  } catch (e) {
    console.warn("  Some navigation guards could not be cleared:", e.message);
  }
}

// Close Dialogs if the window.close not worked
function closeDialogSilently() {
  try {
    // Method 1: Dynamics 365 Navigation API
    if (window.parent && window.parent.Xrm && window.parent.Xrm.Navigation) {
      window.parent.Xrm.Navigation.closeDialog();
      console.log(" Dialog closed via Xrm.Navigation");
      return;
    }

    // Method 2: Standard window close
    window.close();

    // Method 3: Close parent if embedded
    if (window.parent && window.parent !== window) {
      window.parent.close();
    }
  } catch (error) {
    console.error("Error closing dialog:", error);
    // Fallback: try to navigate away
    try {
      window.top.location.reload();
    } catch (e) {
      console.error("Could not reload:", e);
    }
  }
}

// Updated closeCurrentDialog to use the silent version
function closeCurrentDialog() {
  closeDialogSilently();
}

//--------------------------INITIALIZATION FUNCTIONS----------------------------------------//

// Initialize form on load
document.addEventListener("DOMContentLoaded", function () {
  //  Hide Dynamics dialog title bar (e.g. "array_LeaseCreationUI")
  try {
    const parentDoc = window.parent.document;
    // Inject CSS immediately - hides before any paint
    const style = parentDoc.createElement("style");
    style.id = "hideDialogTitle";
    style.textContent =
      '[id^="defaultDialogChromeTitle"] { visibility: hidden !important; }';
    parentDoc.head.appendChild(style);
    // MutationObserver as backup
    const hideTitle = () => {
      const titleEl = parentDoc.querySelector(
        '[id^="defaultDialogChromeTitle"]',
      );
      if (titleEl) titleEl.style.visibility = "hidden";
    };
    const observer = new MutationObserver(() => hideTitle());
    observer.observe(parentDoc.body, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 5000);
  } catch (e) {
    console.warn("Could not hide dialog title:", e);
  }

  // CRITICAL: Completely disable ALL beforeunload handlers
  removeAllNavigationBlockers();

  // Initialize field state tracking
  initializeFieldStateTracking();

  // Load initial data
  loadLeaseTypes();
  loadLeaseTermTypes();

  // Reset to Stage 1 on load
  currentStage = 1;
  completedStages = [];
  maxVisitedStage = 1;

  // Activate Stage 1
  document.querySelectorAll(".stage-content").forEach((stage) => {
    stage.classList.remove("active");
  });
  document.getElementById("stage1").classList.add("active");

  document.querySelectorAll(".stage-item").forEach((item) => {
    item.classList.remove("active", "completed");
  });
  document.querySelector('.stage-item[data-stage="1"]').classList.add("active");

  updateProgressBar();
  updateStageNavigation();
  updateStageLockStates();

  // Lease Term Type change (KEEP - but not for units)
  const leaseTermTypeSelect = document.getElementById("leaseTermType");
  if (leaseTermTypeSelect) {
    leaseTermTypeSelect.addEventListener("change", handleLeaseTermTypeChange);
  }

  // Date inputs
  const startDateInput = document.getElementById("startDate");
  const endDateInput = document.getElementById("endDate");
  const unitsSection = document.getElementById("unitsSection");

  // ---- UNIT VISIBILITY CONTROL (ONLY START DATE) ----
  function toggleUnitsByStartDate() {
    if (!unitsSection || !startDateInput) return;

    unitsSection.style.display = startDateInput.value ? "block" : "none";
  }

  // Date validation (end date min)
  if (startDateInput && endDateInput) {
    startDateInput.addEventListener("change", function () {
      if (this.value) {
        endDateInput.min = this.value;
        if (endDateInput.value && endDateInput.value < this.value) {
          endDateInput.value = "";
          document.getElementById("leaseTerm").value = "";
          showNotification(
            "End date has been cleared as it was earlier than the new start date",
            "warning",
          );
        }
      } else {
        endDateInput.min = "";
      }

      //  ALWAYS re-evaluate units
      toggleUnitsByStartDate();
    });
  }

  //  AUTO-FILL START DATE
  if (startDateInput && !startDateInput.value) {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");

    startDateInput.value = `${yyyy}-${mm}-${dd}`;
    startDateInput.setAttribute("data-user-input", "true");
    updateFieldState(startDateInput);
  }

  //  ENSURE units are shown immediately after auto-fill
  toggleUnitsByStartDate();

  // Auto-populate current user as Property Manager on form open
  autoPopulateCurrentUserAsPropertyManager();

  // Lease Name 100-char indicator
  const leaseNameInput = document.getElementById("leaseName");
  const leaseNameLimitMsg = document.getElementById("leaseNameLimitMsg");

  if (leaseNameInput && leaseNameLimitMsg) {
    leaseNameInput.addEventListener("input", function () {
      leaseNameLimitMsg.style.display =
        this.value.length >= 100 ? "block" : "none";
    });
  }
});

//  field state tracking for visual feedback
function initializeFieldStateTracking() {
  console.log(" Initializing field state tracking...");

  // Get all form inputs (excluding hidden fields)
  const allInputs = document.querySelectorAll(
    'input:not([type="hidden"]):not(.lookup-field), select, textarea',
  );

  console.log(`Found ${allInputs.length} inputs to track`);

  allInputs.forEach((input) => {
    // Mark SELECT elements as empty initially if required
    if (input.tagName === "SELECT" && input.hasAttribute("required")) {
      input.setAttribute("aria-invalid", "true");
    }

    // Idempotency guard: this runs on a timer after EVERY stage change. Without
    // this, each visit re-adds change/input listeners to every field (a leak) so
    // handlers fire multiple times per change - which made the recurring-charge
    // Charge Type dropdown behave erratically. Bind listeners once per element;
    // still refresh the visual state on every call.
    if (input.dataset.fstBound === "1") {
      updateFieldState(input);
      return;
    }
    input.dataset.fstBound = "1";

    // Handle SELECT elements
    if (input.tagName === "SELECT") {
      input.addEventListener("change", function () {
        this.setAttribute("data-user-input", "true");
        updateFieldState(this);
      });
      updateFieldState(input);
    }

    // Handle INPUT elements (excluding lookup fields)
    if (
      input.tagName === "INPUT" &&
      !input.classList.contains("lookup-field")
    ) {
      input.addEventListener("input", function () {
        // Mark as user input
        if (this.value.trim() !== "") {
          this.setAttribute("data-user-input", "true");
        } else {
          this.removeAttribute("data-user-input");
        }
        updateFieldState(this);
      });

      input.addEventListener("change", function () {
        if (this.value.trim() !== "") {
          this.setAttribute("data-user-input", "true");
        } else {
          this.removeAttribute("data-user-input");
        }
        updateFieldState(this);
      });

      updateFieldState(input);
    }

    // Handle TEXTAREA elements
    if (input.tagName === "TEXTAREA") {
      input.addEventListener("input", function () {
        if (this.value.trim() !== "") {
          this.setAttribute("data-user-input", "true");
        } else {
          this.removeAttribute("data-user-input");
        }
        updateFieldState(this);
      });

      input.addEventListener("change", function () {
        if (this.value.trim() !== "") {
          this.setAttribute("data-user-input", "true");
        } else {
          this.removeAttribute("data-user-input");
        }
        updateFieldState(this);
      });

      updateFieldState(input);
    }
  });

  // Handle lookup fields separately
  const lookupFields = document.querySelectorAll(".lookup-field");
  lookupFields.forEach((field) => {
    updateFieldState(field);
  });

  console.log(" Field state tracking initialized");
}

// Field Updating and Their status
function updateFieldState(field) {
  if (!field) return;

  const isRequired =
    field.hasAttribute("required") || field.classList.contains("required");
  const isLookupField = field.classList.contains("lookup-field");
  const isReadonly = field.readOnly || field.hasAttribute("readonly");

  // Handle SELECT elements
  if (field.tagName === "SELECT") {
    const hasValue =
      field.value &&
      field.value !== "" &&
      field.value !== "Select" &&
      !field.value.includes("Select") &&
      !field.value.includes("--");

    if (hasValue) {
      field.classList.add("is-filled");
      field.classList.remove("is-empty");
    } else {
      field.classList.remove("is-filled");
      field.classList.add("is-empty");
    }
    return;
  }

  //  FIX: Handle LOOKUP fields (readonly inputs with values)
  if (isLookupField && isReadonly) {
    const hasValue = field.value && field.value.trim() !== "";

    if (hasValue) {
      field.classList.add("is-filled");
      field.classList.remove("is-empty");
    } else {
      field.classList.remove("is-filled");
      field.classList.add("is-empty");
    }
    return;
  }

  //  FIX: Handle pre-filled readonly fields (like Unit in charge modal)
  if (isReadonly && !isLookupField) {
    const hasValue = field.value && field.value.trim() !== "";

    if (hasValue) {
      field.classList.add("is-filled");
      field.classList.remove("is-empty");
    } else {
      field.classList.remove("is-filled");
      field.classList.add("is-empty");
    }
    return;
  }

  // Handle regular INPUT and TEXTAREA elements
  if (field.tagName === "INPUT" || field.tagName === "TEXTAREA") {
    const hasValue = field.value && field.value.trim() !== "";
    const hasUserInput = field.hasAttribute("data-user-input");

    if (hasValue && hasUserInput) {
      field.classList.add("is-filled");
      field.classList.remove("is-empty");
    } else if (!hasValue) {
      field.classList.remove("is-filled");
      field.classList.add("is-empty");
      if (!hasValue) {
        field.removeAttribute("data-user-input");
      }
    } else {
      field.classList.remove("is-filled");
      field.classList.remove("is-empty");
    }
    return;
  }
}

//-------------------------------------------------DATA LOADING FUNCTIONS (From Dataverse) -----------------------------------//

// Load Lease Types from Dataverse using Web API
function loadLeaseTypes() {
  const leaseTypeSelect = document.getElementById("leaseType");

  if (!leaseTypeSelect) {
    console.error("Lease type select element not found");
    return;
  }

  const clientUrl = XrmContext
    ? XrmContext.Utility.getGlobalContext().getClientUrl()
    : window.location.origin;

  const globalOptionSetName = "array_typeofrentlease";
  const apiUrl = `${clientUrl}/api/data/v9.2/GlobalOptionSetDefinitions(Name='${globalOptionSetName}')/Microsoft.Dynamics.CRM.OptionSetMetadata`;

  fetch(apiUrl, {
    method: "GET",
    headers: {
      "OData-MaxVersion": "4.0",
      "OData-Version": "4.0",
      Accept: "application/json",
      "Content-Type": "application/json; charset=utf-8",
      Prefer: 'odata.include-annotations="*"',
    },
    credentials: "same-origin",
  })
    .then((response) => {
      console.log("Response status:", response.status);
      if (!response.ok) {
        return response.json().then((errorData) => {
          console.error("API Error:", errorData);
          throw new Error(
            `HTTP error ${response.status}: ${
              errorData.error?.message || response.statusText
            }`,
          );
        });
      }
      return response.json();
    })
    .then((data) => {
      console.log("Global choice data retrieved successfully:", data);

      if (
        data &&
        data.Options &&
        Array.isArray(data.Options) &&
        data.Options.length > 0
      ) {
        leaseTypeSelect.innerHTML =
          '<option value="">Select lease type</option>';

        const sortedOptions = data.Options.sort((a, b) => a.Value - b.Value);

        sortedOptions.forEach((option) => {
          const optionElement = document.createElement("option");
          optionElement.value = option.Value;

          let label = "Unknown";
          if (option.Label) {
            if (
              option.Label.UserLocalizedLabel &&
              option.Label.UserLocalizedLabel.Label
            ) {
              label = option.Label.UserLocalizedLabel.Label;
            } else if (
              option.Label.LocalizedLabels &&
              option.Label.LocalizedLabels.length > 0
            ) {
              label = option.Label.LocalizedLabels[0].Label;
            }
          }

          optionElement.textContent = label;
          leaseTypeSelect.appendChild(optionElement);

          console.log(`Added option: ${option.Value} - ${label}`);
        });

        // NEW: Update field state after loading options
        setTimeout(() => {
          updateFieldState(leaseTypeSelect);
        }, 100);
      } else {
        showNotification("No lease types found in system", "error");
        leaseTypeSelect.innerHTML =
          '<option value="">No lease types available</option>';
      }
    })
    .catch((error) => {
      console.error(" Error loading lease types via Web API:", error);
      showNotification("Error loading lease types: " + error.message, "error");
      leaseTypeSelect.innerHTML =
        '<option value="">Error loading lease types</option>';
    });
}

// Load Lease Term Types from Dataverse using Web API
function loadLeaseTermTypes() {
  const leaseTermTypeSelect = document.getElementById("leaseTermType");

  if (!leaseTermTypeSelect) {
    console.error("Lease term type select element not found");
    return;
  }

  const clientUrl = XrmContext
    ? XrmContext.Utility.getGlobalContext().getClientUrl()
    : window.location.origin;

  const globalOptionSetName = "array_leasetermtype";
  const apiUrl = `${clientUrl}/api/data/v9.2/GlobalOptionSetDefinitions(Name='${globalOptionSetName}')/Microsoft.Dynamics.CRM.OptionSetMetadata`;

  fetch(apiUrl, {
    method: "GET",
    headers: {
      "OData-MaxVersion": "4.0",
      "OData-Version": "4.0",
      Accept: "application/json",
      "Content-Type": "application/json; charset=utf-8",
      Prefer: 'odata.include-annotations="*"',
    },
    credentials: "same-origin",
  })
    .then((response) => {
      console.log("Lease Term Type Response status:", response.status);
      if (!response.ok) {
        return response.json().then((errorData) => {
          console.error("API Error:", errorData);
          throw new Error(
            `HTTP error ${response.status}: ${
              errorData.error?.message || response.statusText
            }`,
          );
        });
      }
      return response.json();
    })
    .then((data) => {
      console.log("Lease term type data retrieved successfully:", data);

      if (
        data &&
        data.Options &&
        Array.isArray(data.Options) &&
        data.Options.length > 0
      ) {
        leaseTermTypeSelect.innerHTML =
          '<option value="">Select lease term type</option>';

        const sortedOptions = data.Options.sort((a, b) => a.Value - b.Value);

        sortedOptions.forEach((option) => {
          const optionElement = document.createElement("option");
          optionElement.value = option.Value;

          let label = "Unknown";
          if (option.Label) {
            if (
              option.Label.UserLocalizedLabel &&
              option.Label.UserLocalizedLabel.Label
            ) {
              label = option.Label.UserLocalizedLabel.Label;
            } else if (
              option.Label.LocalizedLabels &&
              option.Label.LocalizedLabels.length > 0
            ) {
              label = option.Label.LocalizedLabels[0].Label;
            }
          }

          optionElement.textContent = label;
          leaseTermTypeSelect.appendChild(optionElement);

          console.log(
            `Added lease term type option: ${option.Value} - ${label}`,
          );
        });

        // NEW: Update field state after loading options
        setTimeout(() => {
          updateFieldState(leaseTermTypeSelect);
        }, 100);
      } else {
        showNotification("No lease term types found in system", "error");
        leaseTermTypeSelect.innerHTML =
          '<option value="">No lease term types available</option>';
      }
    })
    .catch((error) => {
      console.error(" Error loading lease term types via Web API:", error);
      showNotification(
        "Error loading lease term types: " + error.message,
        "error",
      );
      leaseTermTypeSelect.innerHTML =
        '<option value="">Error loading lease term types</option>';
    });
}

// Load Charge Types from Dataverse
function loadChargeTypes() {
  return new Promise((resolve, reject) => {
    XrmContext.WebApi.retrieveMultipleRecords(
      "array_chargetype",
      "?$select=array_chargetypeid,array_name,array_description,array_invoicelinename&$filter=statecode eq 0&$orderby=array_name asc",
    ).then(
      function success(results) {
        resolve(results.entities);
      },
      function error(err) {
        console.error("Error loading charge types:", err);
        reject(err);
      },
    );
  });
}

// Resolve an AI-extracted charge type string to an active Dataverse charge type.
// Accepts "RHAN", legacy "RHAN - Rent - retail space", or "AR - <description>".
// Matches on the code (array_name). When several active records share the code
// (e.g. AR), the text after the first " - " is compared against array_description
// and array_invoicelinename to pick the right one. Ambiguous -> null (left for user).
function resolveChargeType(types, text) {
  const norm = (s) =>
    String(s || "")
      .replace(/[â€žâ€œâ€"]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  const raw = norm(text);
  if (!raw) return null;
  const list = types || [];

  // 1. Whole string equals a name (code-only output, or names like "Service charge")
  let candidates = list.filter((ct) => norm(ct.array_name) === raw);
  let hint = "";

  // 2. "CODE - Description" -> match on the code, keep description as tiebreaker
  if (!candidates.length) {
    const idx = raw.indexOf(" - ");
    if (idx > -1) {
      const code = raw.slice(0, idx).trim();
      hint = raw.slice(idx + 3).trim();
      candidates = list.filter((ct) => norm(ct.array_name) === code);
    }
  }

  if (candidates.length <= 1) return candidates[0] || null;

  // 3. Duplicate codes -> disambiguate by description / invoice line name
  if (hint) {
    const fields = (ct) =>
      [ct.array_description, ct.array_invoicelinename].map(norm).filter(Boolean);
    const exact = candidates.find((ct) => fields(ct).includes(hint));
    if (exact) return exact;
    const partial = candidates.find((ct) =>
      fields(ct).some((f) => f.includes(hint) || hint.includes(f)),
    );
    if (partial) return partial;
  }
  console.warn(
    `Charge type "${text}" matches ${candidates.length} active records; no description match - left unselected.`,
  );
  return null;
}

// Load Currencies from Dataverse
function loadCurrencies() {
  return new Promise((resolve, reject) => {
    XrmContext.WebApi.retrieveMultipleRecords(
      "transactioncurrency",
      "?$select=transactioncurrencyid,currencysymbol,currencyname,exchangerate,isocurrencycode&$filter=statecode eq 0&$orderby=currencyname asc",
    ).then(
      function success(results) {
        console.log(" Currencies loaded:", results.entities.length);
        resolve(results.entities);
      },
      function error(err) {
        console.error(" Error loading currencies:", err);
        reject(err);
      },
    );
  });
}

// Load VAT records from Dataverse
function loadVATs() {
  return new Promise((resolve, reject) => {
    XrmContext.WebApi.retrieveMultipleRecords(
      "array_vat",
      "?$select=array_vatid,array_name,array_vat&$filter=statecode eq 0&$orderby=array_name asc",
    ).then(
      function success(results) {
        console.log(
          "VAT records loaded successfully:",
          results.entities.length,
        );
        resolve(results.entities);
      },
      function error(err) {
        console.error("Error loading VATs:", err);
        resolve([]); // Resolve with empty array instead of rejecting
      },
    );
  });
}

// Load Frequency Options from Global Choice
function loadFrequencies() {
  return new Promise((resolve, reject) => {
    const clientUrl = XrmContext
      ? XrmContext.Utility.getGlobalContext().getClientUrl()
      : window.location.origin;

    const globalOptionSetName = "array_frequency";
    const apiUrl = `${clientUrl}/api/data/v9.2/GlobalOptionSetDefinitions(Name='${globalOptionSetName}')/Microsoft.Dynamics.CRM.OptionSetMetadata`;

    fetch(apiUrl, {
      method: "GET",
      headers: {
        "OData-MaxVersion": "4.0",
        "OData-Version": "4.0",
        Accept: "application/json",
        "Content-Type": "application/json; charset=utf-8",
        Prefer: 'odata.include-annotations="*"',
      },
      credentials: "same-origin",
    })
      .then((response) => {
        if (!response.ok) {
          return response.json().then((errorData) => {
            throw new Error(
              `HTTP ${response.status}: ${errorData.error?.message}`,
            );
          });
        }
        return response.json();
      })
      .then((data) => {
        console.log("Frequency options loaded successfully:", data);
        if (data && Array.isArray(data.Options) && data.Options.length > 0) {
          resolve(data.Options);
        } else {
          console.warn("No frequency options found");
          resolve([]);
        }
      })
      .catch((err) => {
        console.error(" Error loading frequencies:", err);
        reject(err);
      });
  });
}

// Load Days of the Week from Global Choice

// Load Deposit Types from Global Choice
// Load Option Types from global choice field array_OptionType
function loadOptionTypes() {
  return new Promise((resolve, reject) => {
    const clientUrl = XrmContext
      ? XrmContext.Utility.getGlobalContext().getClientUrl()
      : window.location.origin;

    const globalOptionSetName = "array_optiontype";
    const apiUrl = `${clientUrl}/api/data/v9.2/GlobalOptionSetDefinitions(Name='${globalOptionSetName}')/Microsoft.Dynamics.CRM.OptionSetMetadata`;

    fetch(apiUrl, {
      method: "GET",
      headers: {
        "OData-MaxVersion": "4.0",
        "OData-Version": "4.0",
        Accept: "application/json",
        "Content-Type": "application/json; charset=utf-8",
        Prefer: 'odata.include-annotations="*"',
      },
      credentials: "same-origin",
    })
      .then((response) => {
        if (!response.ok) {
          return response.json().then((errorData) => {
            throw new Error(
              `HTTP error ${response.status}: ${errorData.error?.message}`,
            );
          });
        }
        return response.json();
      })
      .then((data) => {
        console.log("Option types loaded successfully:", data);
        if (data && Array.isArray(data.Options) && data.Options.length > 0) {
          resolve(data.Options);
        } else {
          console.warn("No option types found");
          resolve([]);
        }
      })
      .catch((error) => {
        console.error(" Error loading option types:", error);
        reject(error);
      });
  });
}

// Load Option Holder Types from global choice field array_OptionHolder
function loadOptionHolderTypes() {
  return new Promise((resolve, reject) => {
    const clientUrl = XrmContext
      ? XrmContext.Utility.getGlobalContext().getClientUrl()
      : window.location.origin;

    const globalOptionSetName = "array_optionholder";
    const apiUrl = `${clientUrl}/api/data/v9.2/GlobalOptionSetDefinitions(Name='${globalOptionSetName}')/Microsoft.Dynamics.CRM.OptionSetMetadata`;

    fetch(apiUrl, {
      method: "GET",
      headers: {
        "OData-MaxVersion": "4.0",
        "OData-Version": "4.0",
        Accept: "application/json",
        "Content-Type": "application/json; charset=utf-8",
        Prefer: 'odata.include-annotations="*"',
      },
      credentials: "same-origin",
    })
      .then((response) => {
        if (!response.ok) {
          return response.json().then((errorData) => {
            throw new Error(
              `HTTP error ${response.status}: ${errorData.error?.message}`,
            );
          });
        }
        return response.json();
      })
      .then((data) => {
        console.log("Option holder types loaded successfully:", data);
        if (data && Array.isArray(data.Options) && data.Options.length > 0) {
          resolve(data.Options);
        } else {
          console.warn("No option holder types found");
          resolve([]);
        }
      })
      .catch((error) => {
        console.error(" Error loading option holder types:", error);
        reject(error);
      });
  });
}

// Load Due Date Rule Options from Global Choice
function loadDueDateRule() {
  return new Promise((resolve, reject) => {
    const clientUrl = XrmContext
      ? XrmContext.Utility.getGlobalContext().getClientUrl()
      : window.location.origin;

    const globalOptionSetName = "array_duedaterule";
    const apiUrl = `${clientUrl}/api/data/v9.2/GlobalOptionSetDefinitions(Name='${globalOptionSetName}')/Microsoft.Dynamics.CRM.OptionSetMetadata`;

    fetch(apiUrl, {
      method: "GET",
      headers: {
        "OData-MaxVersion": "4.0",
        "OData-Version": "4.0",
        Accept: "application/json",
        "Content-Type": "application/json; charset=utf-8",
        Prefer: 'odata.include-annotations="*"',
      },
      credentials: "same-origin",
    })
      .then((response) => {
        if (!response.ok) {
          return response.json().then((errorData) => {
            throw new Error(
              `HTTP error ${response.status}: ${errorData.error?.message}`,
            );
          });
        }
        return response.json();
      })
      .then((data) => {
        console.log("Due date rule options loaded successfully:", data);
        if (data && Array.isArray(data.Options) && data.Options.length > 0) {
          resolve(data.Options);
        } else {
          console.warn("No due date rule options found");
          resolve([]);
        }
      })
      .catch((error) => {
        console.error(" Error loading due date rules:", error);
        reject(error);
      });
  });
}

// (backed by the "Collateral Types" global choice), with fallback to GlobalOptionSetDefinitions.
function loadCollateralTypes() {
  const clientUrl = XrmContext
    ? XrmContext.Utility.getGlobalContext().getClientUrl()
    : window.location.origin;

  const commonHeaders = {
    "OData-MaxVersion": "4.0",
    "OData-Version": "4.0",
    Accept: "application/json",
    "Content-Type": "application/json; charset=utf-8",
    Prefer: 'odata.include-annotations="*"',
  };

  // Primary: read options from the field's PicklistAttributeMetadata on array_deposit
  const attributeUrl =
    clientUrl +
    "/api/data/v9.2/EntityDefinitions(LogicalName='array_deposit')" +
    "/Attributes(LogicalName='array_type')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata" +
    "?$select=LogicalName&$expand=OptionSet,GlobalOptionSet";

  return fetch(attributeUrl, {
    method: "GET",
    headers: commonHeaders,
    credentials: "same-origin",
  })
    .then(function (res) {
      if (!res.ok) throw new Error("Attribute metadata HTTP " + res.status);
      return res.json();
    })
    .then(function (data) {
      var options =
        (data && data.GlobalOptionSet && data.GlobalOptionSet.Options) ||
        (data && data.OptionSet && data.OptionSet.Options) ||
        [];
      if (options.length > 0) {
        console.log(
          "Collateral types loaded from attribute metadata:",
          options.length,
          options,
        );
        return options;
      }
      throw new Error("No options in attribute metadata response");
    })
    .catch(function (attrErr) {
      // Fallback: query GlobalOptionSetDefinitions with lowercase logical name
      console.warn(
        "Attribute metadata failed, trying GlobalOptionSetDefinitions:",
        attrErr.message,
      );
      var globalUrl =
        clientUrl +
        "/api/data/v9.2/GlobalOptionSetDefinitions(Name='array_type')/Microsoft.Dynamics.CRM.OptionSetMetadata";
      return fetch(globalUrl, {
        method: "GET",
        headers: commonHeaders,
        credentials: "same-origin",
      })
        .then(function (res) {
          if (!res.ok) throw new Error("GlobalOptionSet HTTP " + res.status);
          return res.json();
        })
        .then(function (data) {
          var options = (data && data.Options) || [];
          if (options.length > 0) {
            console.log(
              "Collateral types loaded from GlobalOptionSetDefinitions:",
              options.length,
              options,
            );
            return options;
          }
          console.warn("No collateral types found in either API call");
          return [];
        });
    });
}

// Populate and lock the Collateral Type dropdown, defaulting to Deposit (126330007)
function populateCollateralType() {
  const select = document.getElementById("depositCollateralType");
  if (!select) return;

  select.innerHTML = "";

  const DEFAULT_VALUE = 126330007;

  if (window.collateralTypes && window.collateralTypes.length > 0) {
    window.collateralTypes.forEach((type) => {
      const option = document.createElement("option");
      option.value = type.Value;
      const label =
        type.Label && type.Label.UserLocalizedLabel
          ? type.Label.UserLocalizedLabel.Label
          : type.Label &&
              type.Label.LocalizedLabels &&
              type.Label.LocalizedLabels.length > 0
            ? type.Label.LocalizedLabels[0].Label
            : "Unknown";
      option.textContent = label;
      select.appendChild(option);
    });
  } else {
    // Fallback option if API fails
    const fallback = document.createElement("option");
    fallback.value = DEFAULT_VALUE;
    fallback.textContent = "Deposit";
    select.appendChild(fallback);
  }

  // Default to Deposit (126330007) - field is UNLOCKED, user can change
  select.value = DEFAULT_VALUE;
  select.disabled = false;
  select.style.cursor = "";
  select.style.opacity = "";
  select.style.backgroundColor = "";

  // Apply visibility rules based on default type
  onDepositTypeChange(DEFAULT_VALUE);

  console.log(" Collateral Type defaulted to Deposit (126330007) - editable");
}

// LOAD INVOICE TYPES FROM DATAVERSE
function loadInvoiceTypes() {
  return new Promise((resolve, reject) => {
    XrmContext.WebApi.retrieveMultipleRecords(
      "array_invoicetype",
      "?$select=array_invoicetypeid,array_name,_array_invoiceprefix_value&$filter=statecode eq 0&$orderby=array_name asc",
    ).then(
      function success(results) {
        console.log(" Invoice types loaded:", results.entities.length);
        resolve(results.entities);
      },
      function error(err) {
        console.error(" Error loading invoice types:", err);
        reject(err);
      },
    );
  });
}

// RATE RULE LOOKUP FUNCTIONS
//  Make loadRateRules return a Promise and store rules globally
function loadRateRules(searchTerm = "") {
  // If called without searchTerm and for initial loading
  if (
    !searchTerm &&
    !document
      .getElementById("rateRuleLookupModal")
      ?.classList.contains("active")
  ) {
    return new Promise((resolve, reject) => {
      let filter = "statecode eq 0";

      XrmContext.WebApi.retrieveMultipleRecords(
        "array_exchangerateselectionrules",
        `?$select=array_exchangerateselectionrulesid,array_rulename,array_ruledescription&$filter=${filter}&$orderby=array_rulename asc`,
      ).then(
        function success(results) {
          console.log(
            " Rate rules loaded for auto-population:",
            results.entities.length,
          );
          resolve(results.entities);
        },
        function error(err) {
          console.error(" Error loading rate rules:", err);
          reject(err);
        },
      );
    });
  }

  // Original UI loading logic for the lookup modal
  const resultsContainer = document.getElementById("rateRuleSearchResults");
  if (!resultsContainer) {
    console.warn("Rate rule results container not found");
    return Promise.resolve([]);
  }

  resultsContainer.innerHTML = `
    <div style="min-height: 55vh; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; color: #667eea;">
        <div class="loader" style="margin: 0 auto 12px; width: 40px; height: 40px;"></div>
        <p style="font-size: 14px; color: #64748b;">Loading rate rules...</p>
    </div>
  `;

  let filter = "statecode eq 0";
  if (searchTerm.trim().length > 0) {
    const escapedTerm = searchTerm.trim().replace(/'/g, "''");
    filter += ` and contains(array_rulename,'${escapedTerm}')`;
  }

  return XrmContext.WebApi.retrieveMultipleRecords(
    "array_exchangerateselectionrules",
    `?$select=array_exchangerateselectionrulesid,array_rulename,array_ruledescription&$filter=${filter}&$top=50&$orderby=array_rulename asc`,
  ).then(
    function success(results) {
      if (results.entities.length === 0) {
        resultsContainer.innerHTML = `
          <div style="text-align: center; padding: 40px 20px;">
              <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#cbd5e0" stroke-width="2" style="margin: 0 auto 16px; display: block;">
                  <rect x="3" y="1" width="18" height="22" rx="2" ry="2"/>
                  <line x1="7" y1="7" x2="17" y2="7"/>
                  <line x1="7" y1="12" x2="17" y2="12"/>
                  <line x1="7" y1="17" x2="13" y2="17"/>
              </svg>
              <p style="color: #718096; font-size: 15px; font-weight: 600; margin-bottom: 8px;">
                  No rate rules found
              </p>
              ${
                searchTerm
                  ? `
                  <p style="color: #a0aec0; font-size: 13px;">
                      No results for "<strong>${escapeHtml(
                        searchTerm,
                      )}</strong>"
                  </p>
              `
                  : `
                  <p style="color: #a0aec0; font-size: 13px;">
                      Type to search rate rules
                  </p>
              `
              }
          </div>
        `;
        return results.entities;
      }

      //  ADD RESULTS COUNT BANNER WITH SPACING
      let html = `
        <div style="padding: 12px 16px; background: #f0f9ff; border-left: 4px solid #3b82f6; margin-bottom: 16px; border-radius: 6px;">
            <p style="font-size: 13px; color: #1e40af; margin: 0; font-weight: 600;">
                &#x1F4CB; ${results.entities.length} rate rule${
                  results.entities.length !== 1 ? "s" : ""
                } found
            </p>
        </div>
        <div class="records-list">
      `;

      results.entities.forEach((rule, index) => {
        const escapedName = escapeHtml(rule.array_rulename || "Unnamed Rule");
        const jsEscapedName = escapedName
          .replace(/'/g, "\\'")
          .replace(/"/g, "&quot;");
        const ruleDescription = escapeHtml(rule.array_ruledescription || "");

        html += `
  <div class="record-card" onclick="selectRateRule('${
    rule.array_exchangerateselectionrulesid
  }', '${jsEscapedName}')" 
       style="
         cursor: pointer; 
         transition: all 0.2s ease;
         border-left: 3px solid transparent; 
         padding: 16px; 
         margin-bottom: 8px;
         border-radius: 8px;
         min-height: ${ruleDescription ? "85px" : "70px"};
         display: flex;
         align-items: center;
         ${index % 2 === 0 ? "background: #f8fafc;" : "background: white;"}
       "
       onmouseover="this.style.background='#f0f9ff'; this.style.borderLeftColor='#3b82f6';"
       onmouseout="this.style.background='${
         index % 2 === 0 ? "#f8fafc" : "white"
       }'; this.style.borderLeftColor='transparent';">
      <div style="display: flex; align-items: center; gap: 12px; width: 100%;">
          <div style="background: #dbeafe; width: 44px; height: 44px; border-radius: 8px; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2">
                  <rect x="3" y="1" width="18" height="22" rx="2" ry="2"/>
                  <line x1="7" y1="7" x2="17" y2="7"/>
                  <line x1="7" y1="12" x2="17" y2="12"/>
                  <line x1="7" y1="17" x2="13" y2="17"/>
              </svg>
          </div>
          <div style="flex: 1; min-width: 0; overflow: hidden;">
              <div style="font-size: 15px; font-weight: 700; color: #0f172a; margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                  ${escapedName}
              </div>
              ${
                ruleDescription
                  ? `
                  <div style="font-size: 13px; color: #64748b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                      ${ruleDescription}
                  </div>
              `
                  : ""
              }
          </div>
          <div style="color: #3b82f6; font-size: 18px; flex-shrink: 0;">></div>
      </div>
  </div>
`;
      });
      html += "</div>";
      resultsContainer.innerHTML = html;
      return results.entities;
    },
    function error(err) {
      console.error("Error loading rate rules:", err);
      resultsContainer.innerHTML = `
        <div style="text-align: center; padding: 40px 20px;">
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" style="margin: 0 auto 16px; display: block;">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <p style="color: #dc2626; font-size: 15px; font-weight: 600;">Error Loading</p>
            <p style="color: #991b1b; font-size: 13px;">${escapeHtml(
              err.message || "Unknown error",
            )}</p>
        </div>
      `;
      return [];
    },
  );
}

//Loading Unit Recurring Charge Details related to the Unit
function loadUnitRecurringCharges(unitId) {
  return new Promise((resolve, reject) => {
    console.log(" Starting to load charges for unit ID:", unitId);

    // Step 1: Get unit name and area
    XrmContext.WebApi.retrieveRecord(
      "array_unit",
      unitId,
      "?$select=array_unitname,array_unitareasqm",
    )
      .then((unitResult) => {
        const unitName = unitResult.array_unitname || "-";
        const unitArea = unitResult.array_unitareasqm || 0;
        console.log(" Unit retrieved:", unitName, "area:", unitArea);

        // Step 2: Fetch unit recurring charges via raw fetch with annotations header
        // so we get formatted values for frequency, charge type, and currency
        const clientUrl = XrmContext.Utility.getGlobalContext().getClientUrl();
        const filterVal = encodeURIComponent(
          `_array_unit_value eq ${unitId} and statecode eq 0`,
        );
        const selectVal =
          "array_unitrecurringchargesid,array_name,array_amount,array_frequency,_array_chargetype_value,_transactioncurrencyid_value";
        const url = `${clientUrl}/api/data/v9.2/array_unitrecurringchargeses?$select=${selectVal}&$filter=_array_unit_value%20eq%20${unitId}%20and%20statecode%20eq%200`;

        console.log(" Fetching unit recurring charges...");

        return fetch(url, {
          method: "GET",
          headers: {
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0",
            Accept: "application/json",
            "Content-Type": "application/json; charset=utf-8",
            Prefer: 'odata.include-annotations="*"',
          },
          credentials: "same-origin",
        })
          .then((res) => {
            if (!res.ok)
              throw new Error(
                `HTTP ${res.status} fetching unit recurring charges`,
              );
            return res.json();
          })
          .then((data) => {
            const entities = data.value || [];
            console.log(
              ` Found ${entities.length} charges for unit "${unitName}"`,
            );

            if (entities.length === 0) {
              resolve([]);
              return;
            }

            const charges = entities.map((charge, idx) => {
              // Charge type
              const chargeTypeId = charge._array_chargetype_value || "";
              const chargeTypeName =
                charge[
                  "_array_chargetype_value@OData.Community.Display.V1.FormattedValue"
                ] || "";

              // Frequency
              const frequencyRaw = charge.array_frequency;
              const frequencyName =
                frequencyRaw !== null && frequencyRaw !== undefined
                  ? charge[
                      "array_frequency@OData.Community.Display.V1.FormattedValue"
                    ] || String(frequencyRaw)
                  : "Not Set";

              // Currency - get ID from lookup field; enrich from window.currencies if available
              const currencyId = charge._transactioncurrencyid_value || "";
              let currencyName =
                charge[
                  "_transactioncurrencyid_value@OData.Community.Display.V1.FormattedValue"
                ] || "";
              let currencySymbol = "";
              let currencyCode = "";
              if (
                currencyId &&
                window.currencies &&
                window.currencies.length > 0
              ) {
                const currObj = window.currencies.find(
                  (c) => c.transactioncurrencyid === currencyId,
                );
                if (currObj) {
                  currencyName = `${currObj.currencyname} (${currObj.isocurrencycode})`;
                  currencySymbol = currObj.currencysymbol || "";
                  currencyCode = currObj.isocurrencycode || "";
                }
              }

              console.log(
                `   Charge ${idx + 1}: "${charge.array_name}" | type: ${chargeTypeName} | freq: ${frequencyName} | curr: ${currencyCode || currencyId || "none"}`,
              );

              return {
                id: charge.array_unitrecurringchargesid,
                name: charge.array_name || "Unnamed Charge",
                amount: charge.array_amount ?? 0,
                chargeType: chargeTypeId,
                chargeTypeName: chargeTypeName,
                frequency:
                  frequencyRaw !== null && frequencyRaw !== undefined
                    ? frequencyRaw
                    : "",
                frequencyName: frequencyName,
                unitId: unitId,
                unitName: unitName,
                unitArea: unitArea,
                // Fields auto-populated by autoPopulateUnitRecurringCharges
                vat: "",
                vatName: "",
                startDate: "",
                endDate: "",
                invoiceGenerationDate: "",
                dueInDays: 0,
                dueDateRule: "",
                prorationEnabled: false,
                prorationEnabledFirstCycle: false,
                preFrequencyOffset: false,
                currency: currencyId,
                currencyName: currencyName,
                currencySymbol: currencySymbol,
                currencyCode: currencyCode,
                bankAccount: "",
                bankAccountName: "",
                rateRule: "",
                rateRuleName: "",
                billableArea: 0,
                isExisting: true,
                needsAutoPopulate: true,
              };
            });

            resolve(charges);
          });
      })
      .catch((err) => {
        console.error(
          " Error in loadUnitRecurringCharges for unit:",
          unitId,
          err.message,
        );
        resolve([]); // resolve empty so other units still load
      });
  });
}

//-------------------------------------  STAGE NAVIGATION FUNCTIONS  --------------------------------------------//

// Close every open .modal popup (deposit / charge / option / collateral / lookup
// modals). Used on stage navigation so a popup opened on one stage never bleeds
// onto another. Uses closeModal() for proper per-modal cleanup when possible.
function _closeOpenStageModals() {
  document.querySelectorAll(".modal.active").forEach((m) => {
    if (m.id && typeof closeModal === "function") {
      try {
        closeModal(m.id);
      } catch (e) {
        m.classList.remove("active");
      }
    } else {
      m.classList.remove("active");
    }
  });
  document.body.style.overflow = "";
}

// Each Stage and Function to Go to Each Stage
function goToStage(stageNumber) {
  //  BLOCK ONLY FORWARD navigation if validation fails
  if (typeof closeDiscountModal === "function") closeDiscountModal();
  // Close any stage-specific modal/popup left open (e.g. the "Quick Create:
  // Security & Insurance" deposit modal, charge/option/collateral modals) so it
  // doesn't bleed onto the stage being navigated to. Each popup belongs to its
  // own stage only.
  _closeOpenStageModals();
  if (stageNumber > currentStage) {
    //  SKIP GUARD: cannot jump ahead to a stage whose earlier stages
    //  have not all been visited yet. Sequential progress (T - 1 already
    //  reached) is allowed; jumping over unvisited stages is blocked.
    if (stageNumber - 1 > maxVisitedStage) {
      showNotification(
        "Please complete the previous stages before jumping ahead",
        "error",
      );
      return;
    }

    // Validate EVERY stage being left or skipped (current .. target-1), not just
    // the current one. Otherwise going back (e.g. to Stage 2) and then header-
    // jumping forward (e.g. to Stage 5) would bypass an incomplete intermediate
    // stage (e.g. Stage 3's required recurring charge).
    const _origStage = currentStage;
    for (let s = _origStage; s < stageNumber; s++) {
      currentStage = s;
      if (!validateCurrentStage()) {
        // validateCurrentStage() already showed a stage-specific error.
        currentStage = _origStage;
        // Land the user on the first incomplete stage so the error matches view.
        if (s !== _origStage) goToStage(s);
        return;
      }
    }
    currentStage = _origStage;

    // Every stage from _origStage..stageNumber-1 just passed validation, so mark
    // them completed too - same as clicking Next through each one. Without this,
    // a header jump skips the green-completed marking that nextStage() applies.
    for (let s = _origStage; s < stageNumber; s++) {
      if (!completedStages.includes(s)) completedStages.push(s);
    }
  }

  //  BACKWARD navigation is always allowed

  document.querySelectorAll(".stage-content").forEach((stage) => {
    stage.classList.remove("active");
  });

  document.getElementById("stage" + stageNumber).classList.add("active");

  document.querySelectorAll(".stage-item").forEach((item) => {
    item.classList.remove("active");
    const itemStage = parseInt(item.dataset.stage);
    if (itemStage === stageNumber) {
      item.classList.add("active");
    }
    if (completedStages.includes(itemStage)) {
      item.classList.add("completed");
    }
  });

  currentStage = stageNumber;
  if (stageNumber > maxVisitedStage) {
    maxVisitedStage = stageNumber;
  }
  updateStageLockStates();

  // Load charges when entering Stage 3
  if (stageNumber === 3) {
    if (window._pendingChargesAutofill && recurringCharges.length === 0) {
      // Document autofill takes precedence: apply it INSTEAD of unit auto-populate
      // so the two don't race (the race left recurringCharges without the autofilled
      // charges, so they vanished after navigating away and back).
      _createPartialChargesFromAutofill();
    } else if (units.length > 0) {
      renderRecurringCharges();
    }
    renderCollateralRules();
    renderCollateralConfigs();
    if (window._pendingCollateralAutofill) _createCollateralFromAutofill();
  }

  // Stage 4 = Discounts
  if (stageNumber === 4) {
    loadDiscountDropdowns();
    renderDiscountsTable();
  }

  // Stage 5 = Security & Insurance (deposits). The security-deposit autofill must
  // run here, NOT on the Discounts stage - otherwise the "security deposit(s)
  // pre-filled" toast/records appear while the user is on Discounts.
  if (stageNumber === 5) {
    if (window._pendingSecurityAutofill) {
      _createPartialDepositsFromAutofill();
    }
  }

  // Stage 6: Load Lease Options grid
  if (stageNumber === 6) {
    renderOptionsGrid();
    initializeOptionsModal();
    if (window._pendingOptionsAutofill) _applyOptionsAutofill();
  }

  // Stage 6: Load Lease Clauses (no lease ID yet - clauses are pre-configured before the lease is created)
  if (stageNumber === 7) {
    loadClausesForStage6();
    if (window._pendingClausesAutofill) _applyClausesAutofill();
  }

  // Preview (Stage 7)
  if (stageNumber === 8) {
    // Capture the latest clause data from stage 6 before rendering review
    if (typeof captureStage6ClauseData === "function") {
      captureStage6ClauseData()
        .then(() => {
          updatePreviewContent();
        })
        .catch(() => {
          updatePreviewContent();
        });
    } else {
      updatePreviewContent();
    }
  }

  // Background sub-agent still running and the user landed on one of its stages
  // (Discounts/Options/Clauses): show the loader here until it returns. The
  // _apply* calls above are no-ops while the _pending* globals are still empty.
  if (
    _SUBAGENT_STAGES.includes(stageNumber) &&
    window._subAgentFlowState === "running"
  ) {
    showAutofillProgress(
      "Extracting discounts, options & financial clauses...",
    );
  }

  updateProgressBar();
  updateStageNavigation();

  // Render the read-only autofill discounts panel whenever its stage is shown.
  // Called unconditionally (not tied to a fixed stage number) because the
  // Discount stage's position varies between builds; the function self-guards
  // when there's no pending data or the discount stage isn't in the DOM yet.
  renderAutofillDiscountsPanel();

  setTimeout(() => {
    initializeFieldStateTracking();
  }, 100);

  window.scrollTo({ top: 0, behavior: "smooth" });
}

// Go to Next Stage
function nextStage() {
  if (validateCurrentStage()) {
    if (!completedStages.includes(currentStage)) {
      completedStages.push(currentStage);
    }

    document.querySelectorAll(".stage-item").forEach((item) => {
      const itemStage = parseInt(item.dataset.stage);
      if (completedStages.includes(itemStage)) {
        item.classList.add("completed");
      }
    });

    if (currentStage < 8) {
      const nextStageNum = currentStage + 1;
      goToStage(nextStageNum);
    }
  }
}

// previous Stage
function previousStage() {
  if (currentStage > 1) {
    goToStage(currentStage - 1);
  }
}

// Updating the progress Bar as We Move Each Stage
function updateProgressBar() {
  const progressFill = document.getElementById("progressFill");
  const progress = ((currentStage - 1) / 7) * 100;
  if (progressFill) progressFill.style.width = progress + "%";
  // Footer progress readout (presentation only - no logic impact)
  const pctEl = document.getElementById("navProgressPct");
  if (pctEl) pctEl.textContent = Math.round(progress) + "%";
  const lblEl = document.getElementById("navStepLabel");
  const activeLbl = document.querySelector(".stage-item.active .stage-label");
  if (lblEl && activeLbl) lblEl.textContent = activeLbl.textContent.trim();
}

//  Mark stage headers as locked when their earlier stages haven't been
//  visited yet. A stage T is reachable once maxVisitedStage >= T - 1.
function updateStageLockStates() {
  document.querySelectorAll(".stage-item").forEach((item) => {
    const itemStage = parseInt(item.dataset.stage);
    const isLocked = itemStage - 1 > maxVisitedStage;
    item.classList.toggle("locked", isLocked);
  });
}

//  updateStageNavigation function
function updateStageNavigation() {
  const btnBack = document.getElementById("btnBack");
  const btnNext = document.getElementById("btnNext");
  const btnSaveClose = document.getElementById("btnSaveClose");
  const btnSendForSigning = document.getElementById("btnSendForSigning");
  const btnCloseOnly = document.getElementById("btnCloseOnly");

  if (btnBack) {
    btnBack.style.display = currentStage > 1 ? "inline-flex" : "none";
  }

  if (currentStage < 8) {
    if (btnNext) btnNext.style.display = "inline-flex";
    if (btnSaveClose) btnSaveClose.style.display = "none";
    if (btnSendForSigning) btnSendForSigning.style.display = "none";
    if (btnCloseOnly) btnCloseOnly.style.display = "none";
  }

  if (currentStage === 8) {
    if (btnNext) btnNext.style.display = "none";
    if (btnSaveClose) btnSaveClose.style.display = "inline-flex";
    if (btnSendForSigning) {
      btnSendForSigning.style.display = "inline-flex";
      // Always "Activate Lease": creates the lease and activates it directly.
      // The signing widget is never opened.
      btnSendForSigning.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
          <path d="M5 10L8.5 13.5L15 6.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        Activate Lease
      `;
    }
    if (btnCloseOnly) btnCloseOnly.style.display = "inline-flex";

    if (typeof captureStage6ClauseData === "function") {
      captureStage6ClauseData()
        .then(() => updatePreviewContent())
        .catch(() => updatePreviewContent());
    } else {
      updatePreviewContent();
    }
  }
}

// Validation of Each Stages
function validateStage6Clauses() {
  let valid = true;
  document
    .querySelectorAll(".manual-clause-item-wrapper")
    .forEach((wrapper) => {
      const checkbox = wrapper.querySelector('input[type="checkbox"]');
      if (!checkbox?.checked) return;
      const clauseType = checkbox.getAttribute("data-clause-type");
      const safeType = checkbox.getAttribute("data-safe-type");
      const form = wrapper.querySelector(".manual-clause-details-form");
      if (!form) return;

      // Validates one instance block's own Effective/Expiry date pair.
      // Returns true when valid; sets `valid = false` + notifies otherwise.
      const _validateInstanceDates = (block, label) => {
        const eff = block.querySelector(".clause-effective-date");
        const exp = block.querySelector(".clause-expiry-date");
        if (!eff?.value) {
          showNotification(` ${label} Effective Date is required.`, "error");
          valid = false;
          return false;
        }
        if (!exp?.value) {
          showNotification(` ${label} Expiry Date is required.`, "error");
          valid = false;
          return false;
        }
        if (new Date(exp.value) < new Date(eff.value)) {
          showNotification(
            ` ${label} Expiry Date must be on or after the Effective Date.`,
            "error",
          );
          valid = false;
          return false;
        }
        return true;
      };

      // Single-form clause types keep the shared clause-level header dates.
      const headerDates = form.querySelector(".clause-header-dates");
      if (headerDates) {
        if (!_validateInstanceDates(headerDates, `[${clauseType}]`)) return;
      }

      if (clauseType === "Step Rent Indexation") {
        const instances = form.querySelectorAll("[id^='stepRentFields-']");
        instances.forEach((block, idx) => {
          const label = `[Step Rent - Instance ${idx + 1}]`;
          if (!_validateInstanceDates(block, label)) return;
          const ct = block.querySelector(".charge-type-step-select");
          if (!ct?.value) {
            showNotification(` ${label} Charge Type is required.`, "error");
            valid = false;
            return;
          }
          const it = block.querySelector("select[id^='increaseType-']");
          if (!it?.value) {
            showNotification(` ${label} Increase Type is required.`, "error");
            valid = false;
            return;
          }
          const txt = it.options[it.selectedIndex]?.text.toLowerCase() || "";
          if (txt.includes("percent")) {
            const pi = block.querySelector("[id^='percentField-'] input");
            if (!pi?.value) {
              showNotification(
                ` ${label} Step Rent Percentage is required.`,
                "error",
              );
              valid = false;
              return;
            }
          } else if (txt.includes("flat") || txt.includes("amount")) {
            const fi = block.querySelector("[id^='flatField-'] input");
            if (!fi?.value) {
              showNotification(` ${label} Flat Amount is required.`, "error");
              valid = false;
              return;
            }
          }
          const fs = block.querySelector(".step-rent-frequency-select");
          if (!fs?.value) {
            showNotification(
              ` ${label} Step Rent Frequency is required.`,
              "error",
            );
            valid = false;
            return;
          }
          const tog = block.querySelector(".custom-step-toggle");
          if (tog?.checked) {
            const cs = block.querySelector(".step-cycle-start-input");
            if (!cs?.value) {
              showNotification(
                ` ${label} Step Rent Cycle Start Date is required when Custom Schedule is enabled.`,
                "error",
              );
              valid = false;
              return;
            }
          }
        });
      }

      if (clauseType === "Value Protection (CPI)") {
        const instances = form.querySelectorAll("[id^='cpiFields-']");
        instances.forEach((block, idx) => {
          const label = `[Value Protection (CPI) - Instance ${idx + 1}]`;
          if (!_validateInstanceDates(block, label)) return;

          // -- CPI Type --------------------------------------------------------
          const cpiTypeSel = block.querySelectorAll(
            "select:not(.increase-type-cpi-select):not(.charge-type-cpi-select):not(.cpi-rent-frequency-select)",
          );
          if (!cpiTypeSel[0]?.value) {
            showNotification(` ${label} CPI Type is required.`, "error");
            valid = false;
            return;
          }

          // -- Current Index (NOW REQUIRED) ------------------------------------
          const currentIndexInput = block.querySelector(
            'input[id^="currentIndexInput-"]',
          );
          if (
            !currentIndexInput?.value ||
            currentIndexInput.value.trim() === ""
          ) {
            showNotification(` ${label} Current Index is required.`, "error");
            valid = false;
            return;
          }

          // -- Charge Type (CPI) (NOW REQUIRED) -------------------------------
          const chargeTypeCPISel = block.querySelector(
            ".charge-type-cpi-select",
          );
          if (!chargeTypeCPISel?.value) {
            showNotification(
              ` ${label} Charge Type (CPI) is required.`,
              "error",
            );
            valid = false;
            return;
          }

          // -- Increase Type ---------------------------------------------------
          const its = block.querySelector(".increase-type-cpi-select");
          if (!its?.value) {
            showNotification(` ${label} Increase Type is required.`, "error");
            valid = false;
            return;
          }

          // -- CPI Rent Frequency ----------------------------------------------
          const fs = block.querySelector(".cpi-rent-frequency-select");
          if (!fs?.value) {
            showNotification(
              ` ${label} CPI Rent Frequency is required.`,
              "error",
            );
            valid = false;
            return;
          }

          // -- CPI Reference Month ---------------------------------------------
          const cpiRefSel = block.querySelector(".cpi-reference-month-select");
          if (cpiRefSel && !cpiRefSel.value) {
            showNotification(
              ` ${label} CPI Reference Month is required.`,
              "error",
            );
            valid = false;
            return;
          }

          // -- CPI Custom Month (Yearly + Reference Month = Custom Month) ------
          const cpiCustWrap = block.querySelector(".cpi-custom-month-wrapper");
          const cpiCustSel = block.querySelector(".cpi-custom-month-select");
          if (
            cpiCustWrap &&
            cpiCustWrap.style.display !== "none" &&
            !cpiCustSel?.value
          ) {
            showNotification(
              ` ${label} CPI Custom Month is required when Reference Month is Custom Month.`,
              "error",
            );
            valid = false;
            return;
          }

          // -- Custom Schedule: Cycle Start Date -------------------------------
          const tog = block.querySelector(".custom-cpi-toggle");
          if (tog?.checked) {
            const cs = block.querySelector(".cpi-cycle-start-input");
            if (!cs?.value) {
              showNotification(
                ` ${label} CPI 2nd Schedule Start Date is required when Custom CPI Schedule is enabled.`,
                "error",
              );
              valid = false;
              return;
            }
          }
        });
      }

      if (clauseType === "Turnover Rent") {
        const instances = form.querySelectorAll("[id^='turnoverFields-']");
        instances.forEach((block, idx) => {
          if (!valid) return;
          const label = `[Turnover Rent - Instance ${idx + 1}]`;
          if (!_validateInstanceDates(block, label)) return;

          if (!block.querySelector(".turnover-basis-select")?.value) {
            showNotification(
              ` ${label} Turnover Rent Basis is required.`,
              "error",
            );
            valid = false;
            return;
          }
          const st = block.querySelector(".sales-threshold-input");
          if (!st?.value) {
            showNotification(` ${label} Sales Threshold is required.`, "error");
            valid = false;
            return;
          }
          if (!block.querySelector(".charge-type-turnover-select")?.value) {
            showNotification(
              ` ${label} Charge Type for Advance is required.`,
              "error",
            );
            valid = false;
            return;
          }
          if (!block.querySelector(".turnover-settlement-select")?.value) {
            showNotification(
              ` ${label} Settlement Cycle is required.`,
              "error",
            );
            valid = false;
            return;
          }
          if (!block.querySelector(".turnover-reporting-select")?.value) {
            showNotification(` ${label} Reporting Cycle is required.`, "error");
            valid = false;
            return;
          }
          if (!block.querySelector(".turnover-calc-type-select")?.value) {
            showNotification(
              ` ${label} Turnover Rent Calculation Type is required.`,
              "error",
            );
            valid = false;
            return;
          }
          const incSel = block.querySelector(".turnover-increase-select");
          if (!incSel?.value) {
            showNotification(` ${label} Increase Type is required.`, "error");
            valid = false;
            return;
          }
          const incText =
            incSel.options[incSel.selectedIndex]?.text.toLowerCase() || "";
          if (incText.includes("flat")) {
            const fa = block.querySelector(".turnover-flat-amount-input");
            if (!fa?.value) {
              showNotification(` ${label} Flat Amount is required.`, "error");
              valid = false;
              return;
            }
          } else {
            const tr = block.querySelector(".turnover-rate-input");
            if (!tr?.value) {
              showNotification(
                ` ${label} Turnover Rate (%) is required.`,
                "error",
              );
              valid = false;
              return;
            }
          }
          // Minimum Turnover Percentage is mandatory when OCR is enabled
          if (block.querySelector(".ocr-toggle")?.checked) {
            const mp = block.querySelector(".turnover-min-pct-input");
            if (!mp?.value) {
              showNotification(
                ` ${label} Minimum Turnover Percentage is required when OCR is enabled.`,
                "error",
              );
              valid = false;
              return;
            }
          }
        });
      }
    });
  return valid;
}

function validateCurrentStage() {
  // Block leaving a sub-agent stage (Discounts/Options/Clauses) while autofill is
  // still extracting - otherwise the user advances and the data lands afterwards as
  // incomplete/half-filled fields on a stage they've already passed. Covers BOTH the
  // main pass being in flight (sub-agent not yet started) and the sub-agent running.
  if (
    _SUBAGENT_STAGES.includes(currentStage) &&
    (window._autofillMainInFlight === true ||
      window._subAgentFlowState === "running")
  ) {
    showNotification(
      "Autofill is still extracting data for this stage. Please wait a moment before continuing.",
      "warning",
    );
    return false;
  }

  // Stage 7 clauses are checked/expanded/filled asynchronously by
  // _applyClausesAutofill (after the sub-agent flow is already "done", so the
  // guard above no longer fires). Block Next until that apply finishes, else a
  // fast click validates an empty/half-filled clause set and skips to Review.
  if (
    currentStage === 7 &&
    (window._clausesAutofillInProgress === true ||
      window._pendingClausesAutofill)
  ) {
    showNotification(
      "Financial clauses are still being pre-filled. Please wait a moment before continuing.",
      "warning",
    );
    return false;
  }

  switch (currentStage) {
    case 1:
      if (!document.getElementById("leaseName").value) {
        showNotification("Please enter a lease name", "error");
        return false;
      }
      if (!document.getElementById("leaseType").value) {
        showNotification("Please select a lease type", "error");
        return false;
      }
      if (!document.getElementById("leaseTermType").value) {
        showNotification("Please select a lease term type", "error");
        return false;
      }
      if (!document.getElementById("tenantId").value) {
        showNotification("Please select a tenant", "error");
        return false;
      }
      if (!document.getElementById("propertyId").value) {
        showNotification("Please select a property", "error");
        return false;
      }
      return true;

    case 2:
      const startDate = document.getElementById("startDate").value;
      const endDate = document.getElementById("endDate").value;

      if (!startDate) {
        showNotification("Please select a lease start date", "error");
        return false;
      }

      const leaseTermTypeSelect = document.getElementById("leaseTermType");
      const selectedOption =
        leaseTermTypeSelect.options[leaseTermTypeSelect.selectedIndex];
      const isShortTerm =
        selectedOption &&
        selectedOption.textContent.toLowerCase().includes("month-to-month");

      if (!endDate) {
        showNotification("Please select a lease end date", "error");
        return false;
      }
      if (new Date(endDate) <= new Date(startDate)) {
        showNotification(
          "Lease end date must be after the lease start date",
          "error",
        );
        return false;
      }

      // Validate Move In Date
      const moveInDateVal = document.getElementById("moveInDate")
        ? document.getElementById("moveInDate").value
        : "";
      if (
        moveInDateVal &&
        startDate &&
        new Date(moveInDateVal) < new Date(startDate)
      ) {
        showNotification(
          "Move In Date must be on or after the Lease Start Date",
          "error",
        );
        return false;
      }

      if (isShortTerm) {
        // Units AND Total Area are both OPTIONAL for Month-to-Month
        const totalAreaInput = document.getElementById("totalUnitsArea");
        const totalAreaVal = parseFloat(totalAreaInput?.value);
        totalUnitsAreaValue = totalAreaVal > 0 ? totalAreaVal : 0;
        return true;
      }

      // For all other lease types - units are MANDATORY
      if (units.length === 0) {
        showNotification("Please select at least one unit", "error");
        return false;
      }

      // Total Area is auto-calculated but must be > 0
      const totalAreaInput = document.getElementById("totalUnitsArea");
      const totalAreaVal = parseFloat(totalAreaInput?.value);
      if (!totalAreaVal || totalAreaVal <= 0) {
        showNotification(
          "Please ensure units have a valid total area",
          "error",
        );
        return false;
      }
      totalUnitsAreaValue = totalAreaVal;
      return true;

    case 3:
      if (recurringCharges.length === 0) {
        showNotification(
          " Please add at least one recurring charge before proceeding",
          "error",
        );
        return false;
      }
      if (recurringCharges.some((c) => c.needsCompletion)) {
        showNotification(
          " Please complete all required fields for the pre-filled charge before proceeding.",
          "error",
        );
        return false;
      }
      return true;

    case 4:
      return true;

    case 7:
      return validateStage6Clauses();

    default:
      return true;
  }
}

//--------------------------------------------------. STAGE 1 - BASIC INFORMATION FUNCTIONS----------------------------------------------------------------//

// Open Tenant Lookup Modal
function openTenantLookup() {
  if (!window.parent || !window.parent.Xrm) {
    console.error("Xrm context not available");
    return;
  }

  window.parent.Xrm.Utility.lookupObjects({
    entityTypes: ["account", "contact"],
    allowMultiSelect: false,
    defaultEntityType: "account",
  })
    .then(function (result) {
      if (!result || result.length === 0) return;

      const selected = result[0];
      const cleanId = selected.id.replace(/[{}]/g, "");

      document.getElementById("tenantDisplay").value = selected.name;
      document.getElementById("tenantId").value = cleanId;
      document.getElementById("tenantType").value = selected.entityType;

      updateFieldState(document.getElementById("tenantDisplay"));

      // Show clear button
      const clearTenantBtn = document.getElementById("clearTenantBtn");
      if (clearTenantBtn) clearTenantBtn.style.display = "block";

      // Auto-populate Primary Contact from the selected tenant
      autoPopulateContactFromTenant(cleanId, selected.entityType);

      //for syncing tenant across stages
      syncDepositsWithTenant();

      console.log("Tenant selected:", selected);
    })
    .catch(function (error) {
      console.error("Tenant lookup error:", error);
      showNotification("Failed to open tenant lookup", "error");
    });
}

// Switch between Account and Contact
function switchTenantType(type) {
  currentTenantType = type;

  const btnAccount = document.getElementById("btnAccount");
  const btnContact = document.getElementById("btnContact");

  if (type === "account") {
    btnAccount.classList.remove("btn-secondary");
    btnAccount.classList.add("btn-primary");
    btnContact.classList.remove("btn-primary");
    btnContact.classList.add("btn-secondary");
  } else {
    btnContact.classList.remove("btn-secondary");
    btnContact.classList.add("btn-primary");
    btnAccount.classList.remove("btn-primary");
    btnAccount.classList.add("btn-secondary");
  }

  currentTenantPage = 1;
  hasMoreTenants = true;
  allTenantResults = [];
  currentSearchTerm = "";

  const searchTerm = document.getElementById("tenantSearchBox").value.trim();

  if (searchTerm.length >= 1) {
    searchTenants();
  } else {
    loadInitialTenants();
  }
}

// Search Tenants
function searchTenants() {
  const searchTerm = document.getElementById("tenantSearchBox").value.trim();
  const resultsContainer = document.getElementById("tenantSearchResults");

  if (tenantSearchTimeout) {
    clearTimeout(tenantSearchTimeout);
  }

  if (searchTerm !== currentSearchTerm) {
    currentSearchTerm = searchTerm;
    currentTenantPage = 1;
    hasMoreTenants = true;
    allTenantResults = [];
  }

  resultsContainer.innerHTML = `<div style="min-height: 55vh; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; color: #667eea;">
                Searching...
            </div>`;

  tenantSearchTimeout = setTimeout(() => {
    if (currentTenantType === "account") {
      searchAccounts(searchTerm, false);
    } else {
      searchContacts(searchTerm, false);
    }
  }, 300);
}

// Load initial tenants without search
function loadInitialTenants() {
  if (currentTenantType === "account") {
    searchAccounts("", false);
  } else {
    searchContacts("", false);
  }
}

// Search Accounts
function searchAccounts(searchTerm, isLoadMore) {
  const resultsContainer = document.getElementById("tenantSearchResults");
  const loadingMore = document.getElementById("tenantLoadingMore");
  isLoadingTenants = true;

  const pageSize = 20;

  let filter = "statecode eq 0";
  if (searchTerm.length > 0) {
    const escapedTerm = searchTerm.replace(/'/g, "''");
    filter = `contains(name,'${escapedTerm}') and statecode eq 0`;
  }

  XrmContext.WebApi.retrieveMultipleRecords(
    "account",
    `?$select=accountid,name,emailaddress1,address1_line1,address1_city&$filter=${filter}&$top=${pageSize}&$orderby=name asc`,
  ).then(
    function success(results) {
      isLoadingTenants = false;
      loadingMore.style.display = "none";

      if (results.entities.length < pageSize) {
        hasMoreTenants = false;
      }

      if (!isLoadMore) {
        allTenantResults = results.entities;
      } else {
        allTenantResults = allTenantResults.concat(results.entities);
      }

      if (allTenantResults.length === 0) {
        resultsContainer.innerHTML = `<div style="text-align: center; padding: 20px; color: #718096;">
                            No accounts found${
                              searchTerm
                                ? ` matching "${escapeHtml(searchTerm)}"`
                                : ""
                            }
                        </div>`;
        return;
      }

      renderTenantResults(allTenantResults, "account");
    },
    function error(err) {
      console.error("Error searching accounts:", err);
      isLoadingTenants = false;
      loadingMore.style.display = "none";
      resultsContainer.innerHTML = `<div style="text-align: center; padding: 20px; color: #f56565;">
                        Error searching accounts<br>
                        <small style="font-size: 12px;">${escapeHtml(
                          err.message || "Unknown error",
                        )}</small>
                    </div>`;
    },
  );
}

// Search Contacts
function searchContacts(searchTerm, isLoadMore) {
  const resultsContainer = document.getElementById("tenantSearchResults");
  const loadingMore = document.getElementById("tenantLoadingMore");
  isLoadingTenants = true;

  const pageSize = 20;

  let filter = "statecode eq 0";
  if (searchTerm.length > 0) {
    const escapedTerm = searchTerm.replace(/'/g, "''");
    filter = `contains(fullname,'${escapedTerm}') and statecode eq 0`;
  }

  XrmContext.WebApi.retrieveMultipleRecords(
    "contact",
    `?$select=contactid,fullname,emailaddress1,address1_line1,address1_city&$filter=${filter}&$top=${pageSize}&$orderby=fullname asc`,
  ).then(
    function success(results) {
      isLoadingTenants = false;
      loadingMore.style.display = "none";

      if (results.entities.length < pageSize) {
        hasMoreTenants = false;
      }

      if (!isLoadMore) {
        allTenantResults = results.entities;
      } else {
        allTenantResults = allTenantResults.concat(results.entities);
      }

      if (allTenantResults.length === 0) {
        resultsContainer.innerHTML = `<div style="text-align: center; padding: 20px; color: #718096;">
                            No contacts found${
                              searchTerm
                                ? ` matching "${escapeHtml(searchTerm)}"`
                                : ""
                            }
                        </div>`;
        return;
      }

      renderTenantResults(allTenantResults, "contact");
    },
    function error(err) {
      console.error("Error searching contacts:", err);
      isLoadingTenants = false;
      loadingMore.style.display = "none";
      resultsContainer.innerHTML = `<div style="text-align: center; padding: 20px; color: #f56565;">
                        Error searching contacts<br>
                        <small style="font-size: 12px;">${escapeHtml(
                          err.message || "Unknown error",
                        )}</small>
                    </div>`;
    },
  );
}

// Render tenant results
function renderTenantResults(results, type) {
  const resultsContainer = document.getElementById("tenantSearchResults");

  let html = '<div class="records-list">';

  if (type === "account") {
    results.forEach((account) => {
      const escapedName = escapeHtml(account.name || "Unnamed Account");
      const jsEscapedName = (account.name || "Unnamed Account")
        .replace(/'/g, "\\'")
        .replace(/"/g, "&quot;");

      html += `
                    <div class="record-card" onclick="selectTenant('${
                      account.accountid
                    }', '${jsEscapedName}', 'account')" style="cursor: pointer;">
                        <div class="record-header" style="border: none; padding-bottom: 0;">
                            <span class="record-title">&#x1F3E2; ${escapedName}</span>
                        </div>
                        <div class="record-details" style="margin-top: 8px; grid-template-columns: 1fr;">
                            ${
                              account.emailaddress1
                                ? `<div class="record-detail-item"><strong>Email</strong> ${escapeHtml(
                                    account.emailaddress1,
                                  )}</div>`
                                : ""
                            }
                            ${
                              account.address1_line1
                                ? `<div class="record-detail-item"><strong>Address</strong> ${escapeHtml(
                                    account.address1_line1,
                                  )}</div>`
                                : ""
                            }
                            ${
                              account.address1_city
                                ? `<div class="record-detail-item"><strong>City</strong> ${escapeHtml(
                                    account.address1_city,
                                  )}</div>`
                                : ""
                            }
                        </div>
                    </div>
                `;
    });
  } else {
    results.forEach((contact) => {
      const escapedName = escapeHtml(contact.fullname || "Unnamed Contact");
      const jsEscapedName = (contact.fullname || "Unnamed Contact")
        .replace(/'/g, "\\'")
        .replace(/"/g, "&quot;");

      html += `
                    <div class="record-card" onclick="selectTenant('${
                      contact.contactid
                    }', '${jsEscapedName}', 'contact')" style="cursor: pointer;">
                        <div class="record-header" style="border: none; padding-bottom: 0;">
                            <span class="record-title">&#x1F464; ${escapedName}</span>
                        </div>
                        <div class="record-details" style="margin-top: 8px; grid-template-columns: 1fr;">
                            ${
                              contact.emailaddress1
                                ? `<div class="record-detail-item"><strong>Email</strong> ${escapeHtml(
                                    contact.emailaddress1,
                                  )}</div>`
                                : ""
                            }
                            ${
                              contact.address1_line1
                                ? `<div class="record-detail-item"><strong>Address</strong> ${escapeHtml(
                                    contact.address1_line1,
                                  )}</div>`
                                : ""
                            }
                            ${
                              contact.address1_city
                                ? `<div class="record-detail-item"><strong>City</strong> ${escapeHtml(
                                    contact.address1_city,
                                  )}</div>`
                                : ""
                            }
                        </div>
                    </div>
                `;
    });
  }

  html += "</div>";

  if (hasMoreTenants) {
    html += `<div style="text-align: center; padding: 12px; color: #718096; font-size: 13px;">
                Scroll down to load more results...
            </div>`;
  }

  resultsContainer.innerHTML = html;
}

// Select Tenant
function selectTenant(id, name, type) {
  document.getElementById("tenantId").value = id;
  document.getElementById("tenantType").value = type;
  document.getElementById("tenantDisplay").value = name;
  lastSelectedTenantName = name;

  // Update field state for tenant lookup
  const tenantDisplay = document.getElementById("tenantDisplay");
  updateFieldState(tenantDisplay);

  // Show clear button
  const clearTenantBtn = document.getElementById("clearTenantBtn");
  if (clearTenantBtn) clearTenantBtn.style.display = "block";

  // Auto-populate Primary Contact from the selected tenant
  autoPopulateContactFromTenant(id, type);

  closeModal("tenantLookupModal");
  showNotification("Tenant selected: " + name, "success");
}

// Handle scroll for pagination
function handleTenantScroll() {
  const resultsContainer = document.getElementById("tenantSearchResults");
  const loadingMore = document.getElementById("tenantLoadingMore");

  if (
    resultsContainer.scrollHeight - resultsContainer.scrollTop <=
    resultsContainer.clientHeight + 100
  ) {
    if (hasMoreTenants && !isLoadingTenants) {
      loadingMore.style.display = "block";
      currentTenantPage++;

      if (currentTenantType === "account") {
        searchAccounts(currentSearchTerm, true);
      } else {
        searchContacts(currentSearchTerm, true);
      }
    }
  }
}

// -----------------------------------------------------------------------------
// PRIMARY CONTACT LOOKUP & AUTO-POPULATE  (Stage 1)
// -----------------------------------------------------------------------------

/**
 * Opens the native Dynamics 365 lookup dialog scoped to the Contact table.
 * Called when the user clicks the  icon on the Primary Contact field manually.
 *
 * defaultViewId  : GUID of the out-of-box "Contact Lookup View" (system view).
 *                  Replace with your org's custom view GUID if required.
 * defaultViewType: 1039 = savedquery (system/shared view).
 */
function openContactLookup() {
  if (!window.parent || !window.parent.Xrm) {
    console.error("[ContactLookup] Xrm context not available");
    showNotification("Xrm context not available", "error");
    return;
  }

  window.parent.Xrm.Utility.lookupObjects({
    entityTypes: ["contact"], // restricts dialog to Contact table only
    allowMultiSelect: false,
    defaultEntityType: "contact",
    title: "Select Primary Contact",
    defaultViewId: "00000000-0000-0000-00aa-000010001003", // Contact Lookup View (system default)
    defaultViewType: 1039, // 1039 = savedquery (system view)
  })
    .then(function (result) {
      if (!result || result.length === 0) return;

      const selected = result[0];
      const cleanId = selected.id.replace(/[{}]/g, "");

      // Manual selection - auto-badge is hidden
      setContact(cleanId, selected.name, "contact", false);
      console.log("[ContactLookup] Contact manually selected:", selected.name);
    })
    .catch(function (error) {
      // Dialog dismissed - no error to surface
      console.log("[ContactLookup] Dialog dismissed or error:", error);
    });
}

/**
 * Writes contact data into the three contact DOM fields and
 * toggles the clear button + auto-populated badge.
 *
 * @param {string}  id    - Contact record GUID (no curly braces).
 * @param {string}  name  - Display name shown in the lookup input.
 * @param {string}  type  - Entity logical name (always 'contact').
 * @param {boolean} auto  - true  -> auto-populated from tenant (shows green badge).
 *                          false -> manually selected by user (hides badge).
 */
function setContact(id, name, type, auto) {
  const displayEl = document.getElementById("contactDisplay");
  const idEl = document.getElementById("contactId");
  const typeEl = document.getElementById("contactType");
  const clearBtn = document.getElementById("clearContactBtn");
  const autoMsg = document.getElementById("contactAutoPopulatedMsg");

  if (!displayEl || !idEl) {
    console.warn(
      "[ContactLookup] Contact DOM elements not found - skipping setContact.",
    );
    return;
  }

  idEl.value = id || "";
  typeEl.value = type || "contact";
  displayEl.value = name || "";

  // Update the lookup field visual state
  updateFieldState(displayEl);

  if (name) {
    if (clearBtn) clearBtn.style.display = "block";
    if (autoMsg) autoMsg.style.display = auto ? "flex" : "none";
  } else {
    if (clearBtn) clearBtn.style.display = "none";
    if (autoMsg) autoMsg.style.display = "none";
  }
}

/**
 * Clears all contact field values and resets UI state.
 * Bound to the x clear button on the Primary Contact field.
 */
function clearContactField() {
  setContact("", "", "contact", false);
}

/**
 * Resolves and auto-populates the Primary Contact based on the selected tenant.
 *
 * Logic:
 *   * Tenant is a Contact  -> use the tenant itself as the primary contact.
 *   * Tenant is an Account -> retrieve account's primarycontactid via Xrm.WebApi
 *                             and populate if found; clear field gracefully if none.
 *
 * @param {string} tenantId   - GUID of the selected tenant.
 * @param {string} tenantType - Entity logical name: 'contact' or 'account'.
 */
function autoPopulateContactFromTenant(tenantId, tenantType) {
  if (!tenantId) {
    clearContactField();
    return;
  }

  const cleanId = tenantId.replace(/[{}]/g, "");

  // -- Case 1: Tenant IS a Contact ---------------------------------------------
  if (tenantType === "contact") {
    const tenantName =
      (document.getElementById("tenantDisplay") || {}).value || "";
    setContact(cleanId, tenantName, "contact", true);
    console.log(
      "[ContactLookup] Tenant is a Contact - contact auto-populated:",
      tenantName,
    );
    return;
  }

  // -- Case 2: Tenant is an Account -> fetch Primary Contact via Web API --------
  if (!XrmContext || !XrmContext.WebApi) {
    console.warn(
      "[ContactLookup] XrmContext.WebApi not available - cannot auto-populate contact.",
    );
    return;
  }

  XrmContext.WebApi.retrieveRecord(
    "account",
    cleanId,
    "?$select=name&$expand=primarycontactid($select=contactid,fullname)",
  )
    .then(function (result) {
      if (result && result.primarycontactid) {
        const c = result.primarycontactid;
        setContact(c.contactid, c.fullname, "contact", true);
        console.log(
          "[ContactLookup] Primary contact auto-populated from account:",
          c.fullname,
        );
      } else {
        // Account exists but has no Primary Contact - clear gracefully
        clearContactField();
        console.log(
          "[ContactLookup] Account has no primary contact - contact field cleared.",
        );
      }
    })
    .catch(function (err) {
      console.warn(
        "[ContactLookup] Failed to retrieve primary contact for account:",
        err,
      );
      clearContactField();
    });
}

// -----------------------------------------------------------------------------

// Open Dynamics native lookup for Property Manager (systemuser)
// Auto-populate the Property Manager field with the currently logged-in user
async function autoPopulateCurrentUserAsPropertyManager() {
  try {
    const xrm = window.parent?.Xrm || window.Xrm;
    if (!xrm) {
      console.warn("  Xrm context not available for current user lookup");
      return;
    }

    const globalContext = xrm.Utility.getGlobalContext();
    const userId = globalContext.userSettings.userId.replace(/[{}]/g, "");
    const userName = globalContext.userSettings.userName;

    if (!userId) {
      console.warn("  Could not retrieve current user ID");
      return;
    }

    // Fetch full name from systemuser record for accurate display
    let displayName = userName;
    try {
      const userRecord = await xrm.WebApi.retrieveRecord(
        "systemuser",
        userId,
        "?$select=fullname",
      );
      if (userRecord && userRecord.fullname) {
        displayName = userRecord.fullname;
      }
    } catch (fetchErr) {
      console.warn(
        "  Could not fetch user full name, using login name:",
        fetchErr,
      );
    }

    const displayField = document.getElementById("propertyManagerDisplay");
    const idField = document.getElementById("propertyManagerId");

    if (displayField && idField) {
      displayField.value = displayName;
      idField.value = userId;
      updateFieldState(displayField);
      //  ADD THIS
      const clearBtn = document.getElementById("clearPropertyManagerBtn");
      if (clearBtn) clearBtn.style.display = "block";
      console.log(
        " Property Manager auto-populated with current user:",
        displayName,
        userId,
      );
    }
  } catch (error) {
    console.error(" Error auto-populating Property Manager:", error);
  }
}

function openPropertyManagerLookup() {
  if (!window.parent || !window.parent.Xrm) {
    console.error("Xrm context not available");
    showNotification("Xrm context not available", "error");
    return;
  }

  window.parent.Xrm.Utility.lookupObjects({
    entityTypes: ["systemuser"],
    allowMultiSelect: false,
    defaultEntityType: "systemuser",
  })
    .then(function (result) {
      if (!result || result.length === 0) return;

      const selected = result[0];

      document.getElementById("propertyManagerDisplay").value = selected.name;
      document.getElementById("propertyManagerId").value = selected.id.replace(
        /[{}]/g,
        "",
      );

      updateFieldState(document.getElementById("propertyManagerDisplay"));
      //  ADD THIS
      const clearBtn = document.getElementById("clearPropertyManagerBtn");
      if (clearBtn) clearBtn.style.display = "flex";

      console.log("Property Manager selected:", selected);
    })
    .catch(function (error) {
      console.error("Property Manager lookup error:", error);
      showNotification("Failed to open property manager lookup", "error");
    });
}

function openBrandNameLookup() {
  if (!window.parent || !window.parent.Xrm) {
    console.error("[BrandNameLookup] Xrm context not available");
    showNotification("Xrm context not available", "error");
    return;
  }

  const tenantId = document.getElementById("tenantId").value;
  const tenantType = document.getElementById("tenantType").value;

  if (!tenantId || !tenantType) {
    showNotification(
      " Please select a Tenant first before choosing a Brand",
      "error",
    );
    return;
  }

  const tenantCondition =
    tenantType === "account"
      ? `<condition attribute="array_tenant" operator="eq" uitype="account" value="${tenantId}"/>`
      : `<condition attribute="array_tenant" operator="eq" uitype="contact" value="${tenantId}"/>`;

  window.parent.Xrm.Utility.lookupObjects({
    entityTypes: ["array_brandleaseassociation"],
    allowMultiSelect: false,
    defaultEntityType: "array_brandleaseassociation",
    title: "Select Brand (filtered by Tenant)",
    disableMru: true,
    filters: [
      {
        filterXml: `<filter type="and">
          <condition attribute="statecode" operator="eq" value="0"/>
          ${tenantCondition}
        </filter>`,
        entityLogicalName: "array_brandleaseassociation",
      },
    ],
  })
    .then(function (result) {
      if (!result || result.length === 0) return;

      const selected = result[0];
      const associationId = selected.id.replace(/[{}]/g, "");

      console.log(
        "[BrandNameLookup] Association selected:",
        selected.name,
        associationId,
      );

      const xrm = window.parent.Xrm || window.Xrm;

      xrm.WebApi.retrieveRecord(
        "array_brandleaseassociation",
        associationId,
        "?$select=array_name,_array_brand_value",
      )
        .then(function (record) {
          const brandId = record["_array_brand_value"];
          const brandName =
            record[
              "_array_brand_value@OData.Community.Display.V1.FormattedValue"
            ] ||
            selected.name ||
            "";

          if (!brandId) {
            showNotification(
              "  No Brand linked to the selected association record",
              "warning",
            );
            return;
          }

          const brandDisplay = document.getElementById("brandNameDisplay");
          const brandIdField = document.getElementById("brandNameId");
          const clearBrandBtn = document.getElementById("clearBrandNameBtn");

          if (brandDisplay) {
            brandDisplay.value = brandName;
            updateFieldState(brandDisplay);
          }
          if (brandIdField) brandIdField.value = brandId;
          if (clearBrandBtn) clearBrandBtn.style.display = "block";

          showNotification(" Brand selected: " + brandName, "success");
          console.log("[BrandNameLookup] Brand populated:", brandName, brandId);
        })
        .catch(function (err) {
          console.error(
            "[BrandNameLookup] Failed to fetch brand details:",
            err,
          );
          showNotification(" Could not load brand details", "error");
        });
    })
    .catch(function (error) {
      console.log("[BrandNameLookup] Dialog dismissed or error:", error);
    });
}

function clearBrandNameField() {
  const brandDisplay = document.getElementById("brandNameDisplay");
  const brandId = document.getElementById("brandNameId");
  const clearBrandBtn = document.getElementById("clearBrandNameBtn");

  if (brandDisplay) {
    brandDisplay.value = "";
    updateFieldState(brandDisplay);
  }
  if (brandId) brandId.value = "";
  if (clearBrandBtn) clearBrandBtn.style.display = "none";
}

// Open Quick Create form for Brand Lease Association
function _openBrandLeaseAssociationQuickCreate(tenantId, tenantType) {
  const xrm = window.parent?.Xrm || window.Xrm;
  if (!xrm || !xrm.Navigation) {
    showNotification(" Xrm.Navigation not available", "error");
    return;
  }

  // Build default values to pre-fill the tenant on the Quick Create form
  // The polymorphic "Tenant" field on array_brandleaseassociation uses
  // array_tenant as the logical name. For polymorphic lookups, Dynamics
  // expects the entity-type-specific parameter name.
  const defaultValues = {};

  if (tenantType === "account") {
    defaultValues["array_tenant_account"] = tenantId;
  } else if (tenantType === "contact") {
    defaultValues["array_tenant_contact"] = tenantId;
  }

  xrm.Navigation.openForm(
    {
      entityName: "array_brandleaseassociation",
      useQuickCreateForm: true,
    },
    defaultValues,
  )
    .then(function (result) {
      console.log("[BrandQuickCreate] Quick Create result:", result);

      if (
        result &&
        result.savedEntityReference &&
        result.savedEntityReference.length > 0
      ) {
        const newAssocId = result.savedEntityReference[0].id.replace(
          /[{}]/g,
          "",
        );
        const newAssocName = result.savedEntityReference[0].name || "";

        console.log(
          "[BrandQuickCreate] New association created:",
          newAssocId,
          newAssocName,
        );

        const xrm2 = window.parent?.Xrm || window.Xrm;
        xrm2.WebApi.retrieveRecord(
          "array_brandleaseassociation",
          newAssocId,
          "?$select=array_name,_array_brand_value",
        )
          .then(function (record) {
            const brandId = record["_array_brand_value"];
            const brandName =
              record[
                "_array_brand_value@OData.Community.Display.V1.FormattedValue"
              ] ||
              newAssocName ||
              "";

            if (!brandId) {
              showNotification(
                "  Record created but no Brand is linked yet. Please select a Brand manually.",
                "warning",
              );
              return;
            }

            const brandDisplay = document.getElementById("brandNameDisplay");
            const brandIdField = document.getElementById("brandNameId");
            const clearBrandBtn = document.getElementById("clearBrandNameBtn");

            if (brandDisplay) {
              brandDisplay.value = brandName;
              updateFieldState(brandDisplay);
            }
            if (brandIdField) brandIdField.value = brandId;
            if (clearBrandBtn) clearBrandBtn.style.display = "block";

            showNotification(
              " Brand Lease Association created and selected: " + brandName,
              "success",
            );

            console.log(
              "[BrandQuickCreate] Brand auto-populated after Quick Create:",
              brandName,
              brandId,
            );
          })
          .catch(function (err) {
            console.warn(
              "[BrandQuickCreate] Could not fetch brand from new association:",
              err,
            );
            showNotification(
              "  Association created. Please select it from the Brand lookup.",
              "warning",
            );
          });
      } else {
        console.log(
          "[BrandQuickCreate] Quick Create dismissed without saving.",
        );
      }
    })
    .catch(function (error) {
      console.log("[BrandQuickCreate] Quick Create dismissed or error:", error);
    });
}

// Clear Tenant lookup field
function clearTenantField() {
  const tenantDisplay = document.getElementById("tenantDisplay");
  const tenantId = document.getElementById("tenantId");
  const tenantType = document.getElementById("tenantType");
  const clearTenantBtn = document.getElementById("clearTenantBtn");

  if (tenantDisplay) {
    tenantDisplay.value = "";
    updateFieldState(tenantDisplay);
  }
  if (tenantId) tenantId.value = "";
  if (tenantType) tenantType.value = "";
  if (clearTenantBtn) clearTenantBtn.style.display = "none";
  lastSelectedTenantName = "";
}

// Open Property Lookup Modal
function openPropertyLookup() {
  document.getElementById("propertyLookupModal").classList.add("active");
  document.body.style.overflow = "hidden";
  document.getElementById("propertySearchBox").value = "";

  // Show/hide deselect button based on current selection
  const currentValue = document.getElementById("propertyId").value;
  const deselectBtn = document.getElementById("btnDeselectProperty");
  if (deselectBtn) {
    deselectBtn.style.display = currentValue ? "inline-flex" : "none";
  }

  // Focus search box
  setTimeout(() => {
    document.getElementById("propertySearchBox").focus();
  }, 100);

  loadProperties();
}

//  Deselect Property Function
function deselectProperty() {
  clearPropertyField();
  closeModal("propertyLookupModal");
  showNotification("Property deselected", "info");
}

// Clear Property Field Function
function clearPropertyField() {
  document.getElementById("propertyId").value = "";
  document.getElementById("propertyDisplay").value = "";

  const display = document.getElementById("propertyDisplay");
  display.removeAttribute("data-user-input");
  updateFieldState(display);

  // Hide the clear button
  const clearBtn = document.getElementById("clearPropertyBtn");
  if (clearBtn) {
    clearBtn.style.display = "none";
  }

  units = [];
  recurringCharges = [];
  deposits = [];
  _showUnitNotFoundHint([]);
  renderUnits();
  renderRecurringCharges();
  renderDeposits();
}

// Load/Search Properties
function loadProperties(searchTerm = "") {
  const resultsContainer = document.getElementById("propertySearchResults");

  resultsContainer.innerHTML = `
    <div style="min-height: 55vh; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center;">
        <div class="loader" style="margin: 0 auto 14px; width: 42px; height: 42px;"></div>
        <p style="font-size: 14px; color: #64748b;">Loading properties...</p>
    </div>
  `;

  let filter = "statecode eq 0";
  if (searchTerm.trim().length > 0) {
    const escapedTerm = searchTerm.trim().replace(/'/g, "''");
    filter += ` and contains(array_propertyname,'${escapedTerm}')`;
  }

  XrmContext.WebApi.retrieveMultipleRecords(
    "array_property",
    `?$select=array_propertyid,array_propertyname,array_propertyrecordid,array_streetaddress,array_city,array_postalcode,array_vacantunits,array_totalunits,_array_country_value&$filter=${filter}&$top=50&$orderby=array_propertyname asc`,
  ).then(
    function success(results) {
      if (results.entities.length === 0) {
        resultsContainer.innerHTML = `
          <div style="text-align: center; padding: 40px 20px;">
              <p style="color: #718096; font-size: 15px; font-weight: 600; margin-bottom: 8px;">
                  No properties found
              </p>
          </div>
        `;
        return;
      }

      let html = `
        <div style="padding: 12px 16px; background: #f0f9ff; border-left: 4px solid #3b82f6; margin-bottom: 16px; border-radius: 6px;">
            <p style="font-size: 13px; color: #1e40af; margin: 0; font-weight: 600;">
                &#x1F3E2; ${results.entities.length} propert${results.entities.length !== 1 ? "ies" : "y"} found
            </p>
        </div>
        <div class="records-list" style="overflow:hidden;">
      `;

      results.entities.forEach((property, index) => {
        const escapedName = escapeHtml(
          property.array_propertyname || "Unnamed Property",
        );
        const jsEscapedName = (
          property.array_propertyname || "Unnamed Property"
        )
          .replace(/'/g, "\\'")
          .replace(/"/g, "&quot;");
        const propertyRecordId = property.array_propertyrecordid || "N/A";
        const countryName =
          property[
            "_array_country_value@OData.Community.Display.V1.FormattedValue"
          ] || null;
        const totalUnits = property.array_totalunits || 0;
        const vacantUnits = property.array_vacantunits || 0;
        const occupiedUnits = totalUnits - vacantUnits;

        html += `
          <div class="record-card"
               onclick="selectProperty('${property.array_propertyid}', '${jsEscapedName}')"
               style="padding:14px 16px;">
            <div style="display: flex; align-items: center; gap: 14px; pointer-events: none;">
                <div class="record-icon">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>
                        <polyline points="9 22 9 12 15 12 15 22"/>
                    </svg>
                </div>
                <div style="flex: 1; min-width: 0;">
                    <div style="font-size: 15px; font-weight: 700; color: var(--text); margin-bottom: 4px; display: flex; align-items: center; gap: 8px; flex-wrap:wrap;">
                        ${escapedName}
                        <span style="font-size: 11px; color: var(--blue); font-weight: 700; background: var(--blue-l); padding: 3px 10px; border-radius: 10px;">ID: ${escapeHtml(propertyRecordId)}</span>
                    </div>
                    <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px 16px; margin-top: 8px;">
                        ${property.array_streetaddress ? `<div style="font-size: 12px; color: var(--sub);"><strong style="color:var(--text);font-weight:600;">Address:</strong> ${escapeHtml(property.array_streetaddress)}</div>` : ""}
                        ${property.array_city ? `<div style="font-size: 12px; color: var(--sub);"><strong style="color:var(--text);font-weight:600;">City:</strong> ${escapeHtml(property.array_city)}</div>` : ""}
                        ${countryName ? `<div style="font-size: 12px; color: var(--sub);"><strong style="color:var(--text);font-weight:600;">Country:</strong> ${escapeHtml(countryName)}</div>` : ""}
                        ${totalUnits ? `<div style="font-size: 12px; color: var(--sub);"><strong style="color:var(--text);font-weight:600;">Units:</strong> ${totalUnits} (${occupiedUnits} occupied, ${vacantUnits} vacant)</div>` : ""}
                    </div>
                </div>
                <div class="record-arrow">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                </div>
            </div>
          </div>
        `;
      });

      html += "</div>";
      resultsContainer.innerHTML = html;
    },
    function error(err) {
      console.error("Error loading properties:", err);
      resultsContainer.innerHTML = `
        <div style="text-align: center; padding: 40px 20px;">
            <p style="color: #dc2626; font-size: 15px; font-weight: 600;">Error Loading</p>
        </div>
      `;
    },
  );
}

// Search Properties
function searchProperties() {
  const searchTerm = document.getElementById("propertySearchBox").value;

  if (propertySearchTimeout) {
    clearTimeout(propertySearchTimeout);
  }

  propertySearchTimeout = setTimeout(() => {
    loadProperties(searchTerm);
  }, 300);
}

// Select Property
function selectProperty(id, name) {
  const prevId = document.getElementById("propertyId").value;

  // Re-selecting the SAME property is a no-op - don't disturb units/charges.
  if (prevId && prevId === id) {
    closeModal("propertyLookupModal");
    return;
  }

  document.getElementById("propertyId").value = id;
  document.getElementById("propertyDisplay").value = name;

  const propertyDisplay = document.getElementById("propertyDisplay");
  propertyDisplay.setAttribute("data-user-input", "true");
  updateFieldState(propertyDisplay);

  // Show the clear button
  const clearBtn = document.getElementById("clearPropertyBtn");
  if (clearBtn) {
    clearBtn.style.display = "flex";
  }

  closeModal("propertyLookupModal");

  // Units belong to a property, so the unit selection is reset on change. But
  // charges and deposits (incl. autofilled data) are NOT deleted - only their
  // unit ASSOCIATION is cleared, so the records survive and the user can simply
  // re-assign a unit from the newly chosen property. Re-selecting units later
  // keeps these via loadAndAutoPopulateAllUnitCharges' "manual charge" merge.
  const _hadUnits = units.length > 0;
  units = [];
  updateTotalUnitsArea();
  recurringCharges.forEach((c) => {
    c.unitId = null;
    c.unitName = "No Unit";
  });
  deposits.forEach((d) => {
    d.unitId = null;
    d.unitName = "No Unit";
  });
  renderUnits();
  renderRecurringCharges();
  renderDeposits();

  showNotification("Property selected: " + name, "success");
  if (_hadUnits) {
    showNotification(
      "Unit selection was reset for the new property. Your charges and deposits are kept - re-select units to re-link them.",
      "info",
    );
  }
}

// Handle Lease Term Type Change - Show/Hide End Date
function handleLeaseTermTypeChange() {
  const leaseTermTypeSelect = document.getElementById("leaseTermType");
  const endDateGroup = document
    .querySelector("#endDate")
    .closest(".form-group");
  const leaseTermGroup = document
    .querySelector("#leaseTerm")
    .closest(".form-group");

  if (!leaseTermTypeSelect || !endDateGroup) return;

  const selectedOption =
    leaseTermTypeSelect.options[leaseTermTypeSelect.selectedIndex];
  const selectedText = selectedOption
    ? selectedOption.textContent.toLowerCase()
    : "";

  // Check if "Short Term" is selected
  const isShortTerm = selectedText.includes("month-to-month");

  if (isShortTerm) {
    // Show End Date (REQUIRED for Month-to-Month too) but hide Lease Term months
    endDateGroup.style.display = "";
    if (leaseTermGroup) leaseTermGroup.style.display = "none";

    // Clear lease term value (End Date value preserved - user must set one)
    document.getElementById("leaseTerm").value = "";

    // End Date is REQUIRED for Month-to-Month
    document.getElementById("endDate").setAttribute("required", "required");
    // Remove required asterisk from Select Unit label
    const unitLabel = document.querySelector("#unitsSection label.required");
    if (unitLabel) unitLabel.classList.remove("required");
  } else {
    // Show end date and lease term fields for other types
    endDateGroup.style.display = "";
    if (leaseTermGroup) leaseTermGroup.style.display = "";

    // Add required attribute back
    document.getElementById("endDate").setAttribute("required", "required");
    // Restore required asterisk on Select Unit label
    const unitLabelRestore = document.querySelector("#unitsSection label");
    if (unitLabelRestore) unitLabelRestore.classList.add("required");
  }

  // Update field states
  setTimeout(() => {
    updateFieldState(document.getElementById("endDate"));
    updateFieldState(document.getElementById("leaseTerm"));
  }, 50);
  // Toggle total area editability
  const totalAreaGroup = document.getElementById("totalUnitsAreaGroup");
  const totalAreaInput = document.getElementById("totalUnitsArea");
  const totalAreaHint = document.getElementById("totalAreaHint");

  if (totalAreaGroup && totalAreaInput) {
    if (isShortTerm) {
      // Show and make editable
      totalAreaGroup.style.display = "block";
      totalAreaInput.readOnly = false;
      totalAreaInput.style.background = "";
      totalAreaInput.style.cursor = "";
      totalAreaInput.placeholder = "Enter total area manually";
      if (totalAreaHint) {
        totalAreaHint.textContent =
          "Enter total area manually - units are optional for Month-to-Month leases";
        totalAreaHint.style.color = "#059669";
      }
      // Auto-fill if units already selected
      if (units.length > 0) {
        totalAreaInput.value = totalUnitsAreaValue.toFixed(2);
      }
    } else {
      // Readonly
      totalAreaInput.readOnly = true;
      totalAreaInput.style.background = "#f1f5f9";
      totalAreaInput.style.cursor = "not-allowed";
      totalAreaInput.placeholder = "Auto-calculated from selected units";
      if (totalAreaHint) {
        totalAreaHint.textContent = "Auto-calculated from selected units";
        totalAreaHint.style.color = "#94a3b8";
      }
      updateTotalUnitsArea();
      if (units.length === 0) {
        totalAreaGroup.style.display = "none";
      }
    }
  }
}

//-----------------------------------------------------------  STAGE 2 - CONTRACT TERMS & UNITS FUNCTIONS --------------------------------------------------//

// Handle Date Change
function handleDateChange() {
  calculateLeaseTerm();

  const startDate = document.getElementById("startDate").value;
  const endDate = document.getElementById("endDate").value;
  const unitsSection = document.getElementById("unitsSection");

  // **UPDATED**: Check if Short Term lease
  const leaseTermTypeSelect = document.getElementById("leaseTermType");
  const selectedOption =
    leaseTermTypeSelect.options[leaseTermTypeSelect.selectedIndex];
  const isShortTerm =
    selectedOption &&
    selectedOption.textContent.toLowerCase().includes("month-to-month");

  // **UPDATED**: Show units section if start date is selected
  // For Short Term: only need start date
  // For other types: need both start and end dates
  if (isShortTerm && startDate) {
    // Short Term: Show units section if start date exists
    unitsSection.style.display = "block";
    unitsSection.style.animation = "fadeIn 0.3s ease-in";
  } else if (!isShortTerm && startDate && endDate) {
    // Other lease types: Show units section if both dates exist
    unitsSection.style.display = "block";
    unitsSection.style.animation = "fadeIn 0.3s ease-in";
  } else {
    // Only wipe when the user clears a date of a section that was visible.
    // When the section is already hidden (e.g. autofill cleared an undetermined
    // start/end date and then auto-selected the document's unit), entering the
    // first date must NOT drop the auto-selected units and charges.
    const _wasVisible = unitsSection.style.display !== "none";
    // Hide units section if required dates are missing
    unitsSection.style.display = "none";
    // Clear units if dates are cleared
    if (_wasVisible && (!startDate || (!isShortTerm && !endDate))) {
      units = [];
      recurringCharges = [];
      deposits = [];
      renderUnits();
    }
  }
}

// Calculate lease term
function calculateLeaseTerm() {
  const startDateInput = document.getElementById("startDate");
  const endDateInput = document.getElementById("endDate");
  const leaseTermInput = document.getElementById("leaseTerm");
  const startDate = startDateInput.value;
  const endDate = endDateInput.value;

  if (startDate && endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);

    if (end < start) {
      leaseTermInput.value = "";
      endDateInput.value = "";
      showNotification("End date cannot be earlier than start date", "error");

      // NEW: Update field states
      updateFieldState(endDateInput);
      updateFieldState(leaseTermInput);
      return;
    }

    const months =
      (end.getFullYear() - start.getFullYear()) * 12 +
      (end.getMonth() - start.getMonth());
    leaseTermInput.value = months;

    // NEW: Update field states
    updateFieldState(startDateInput);
    updateFieldState(endDateInput);
    updateFieldState(leaseTermInput);
  }
}

// Open Unit Lookup Modal
function openUnitLookup() {
  const propertyId = document.getElementById("propertyId").value;
  const leaseStartDate = document.getElementById("startDate").value;

  // Check if property is selected
  if (!propertyId) {
    showNotification("Please select a property first in Stage 1", "error");
    return;
  }

  // **UPDATED**: Only require start date
  if (!leaseStartDate) {
    showNotification(
      "Please select lease start date in Stage 2 first",
      "error",
    );
    return;
  }

  // Copy current selections to temp array
  tempSelectedUnits = [...units];

  // Open the modal
  document.getElementById("unitLookupModal").classList.add("active");
  document.body.style.overflow = "hidden";
  document.getElementById("unitSearchBox").value = "";

  // Load units for the selected property
  loadUnitsInModal(propertyId);
}

// Load Units in Modal
function loadUnitsInModal(propertyId, searchTerm = "") {
  const resultsContainer = document.getElementById("unitSearchResults");
  resultsContainer.innerHTML = `<div style="min-height: 55vh; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center;">
            <div class="loader" style="margin: 0 auto 14px; width: 42px; height: 42px;"></div>
            <p style="font-size: 14px; color: #64748b;">Loading available units...</p>
        </div>`;

  // Get lease start date from Stage 2
  const leaseStartDate = document.getElementById("startDate").value;
  console.log("leasestartdate", leaseStartDate);

  if (!leaseStartDate) {
    resultsContainer.innerHTML = `<div style="text-align: center; padding: 20px; color: #f56565;">
                Please select lease start date in Stage 2 first
            </div>`;
    return;
  }

  //  Fetch units with their CURRENT LEASE START DATES
  const fetchXml = `
        <fetch version="1.0" output-format="xml-platform" mapping="logical" distinct="false">
            <entity name="array_unit">
                <attribute name="array_unitid"/>
                <attribute name="array_currentlease"/>
                 <attribute name="array_floor"/>
                <filter type="and">
                    <condition attribute="statecode" operator="eq" value="0"/>
                    <condition attribute="array_property" operator="eq" uitype="array_property" value="${propertyId}"/>
                   
                </filter>
                <link-entity name="array_leaseagreement" from="array_leaseagreementid" to="array_currentlease" link-type="outer" alias="lease">
                    <attribute name="array_leasestartdate"/>
                    <attribute name="array_leaseenddate"/>
                </link-entity>
                <link-entity name="array_floor" from="array_floorid" to="array_floor" link-type="outer" alias="floor">
    <attribute name="array_floorname"/>
    <attribute name="array_floorrecordid"/>
</link-entity>
            </entity>
        </fetch>
    `;

  XrmContext.WebApi.retrieveMultipleRecords(
    "array_unit",
    "?fetchXml=" + encodeURIComponent(fetchXml),
  ).then(
    async function success(results) {
      // <- Add 'async' keyword here
      console.log(" Units with lease data:", results.entities);

      const ourStartDate = new Date(leaseStartDate);
      const availableUnitIds = [];
      const unitLeaseMap = {}; // <- NEW: Add this line
      console.log("ourstartdate", ourStartDate);

      results.entities.forEach((unit) => {
        const currentLeaseId = unit._array_currentlease_value;
        const leaseStartDateValue = unit["lease.array_leaseenddate"];
        console.log("leaseenddate", leaseStartDateValue);

        if (!currentLeaseId) {
          availableUnitIds.push(unit.array_unitid);
          console.log(
            ` Unit ${unit.array_unitid}: Available (no current lease - no date check needed)`,
          );
          return;
        }

        // <- NEW: Add these 2 lines (store lease ID for later)
        unitLeaseMap[unit.array_unitid] = currentLeaseId;

        if (leaseStartDateValue) {
          const existingLeaseStartDate = new Date(leaseStartDateValue);
          console.log(existingLeaseStartDate);

          if (ourStartDate > existingLeaseStartDate) {
            availableUnitIds.push(unit.array_unitid);
            console.log(
              ` Unit ${unit.array_unitid}: Available (our start ${leaseStartDate} > current lease start ${leaseStartDateValue})`,
            );
          } else {
            console.log(
              ` Unit ${unit.array_unitid}: Not available (our start ${leaseStartDate} <= current lease start ${leaseStartDateValue})`,
            );
          }
        } else {
          console.log(
            `  Unit ${unit.array_unitid}: Has current lease but no start date - treating as unavailable`,
          );
        }
      });

      console.log(" Available units:", availableUnitIds.length);
      const unitRentCharges = await fetchRentChargesForUnits(
        unitLeaseMap,
        availableUnitIds,
      );

      loadAvailableUnits(
        propertyId,
        searchTerm,
        availableUnitIds,
        resultsContainer,
        unitRentCharges,
      );
    },
    function error(err) {
      console.error(" Error loading units:", err);
      resultsContainer.innerHTML = `<div style="text-align: center; padding: 20px; color: #f56565;">
                Error loading units<br>
                <small style="font-size: 12px;">${escapeHtml(
                  err.message || "Unknown error",
                )}</small>
            </div>`;
    },
  );
}

// Fetch rent charges for available units only
async function fetchRentChargesForUnits(unitLeaseMap, availableUnitIds) {
  const unitRentCharges = {};

  // Only get leases for available units
  const availableLeaseIds = availableUnitIds
    .map((unitId) => unitLeaseMap[unitId])
    .filter((leaseId) => leaseId); // Remove undefined values

  if (availableLeaseIds.length === 0) {
    console.log("&#x1F4B0; No leases to fetch rent charges for");
    return unitRentCharges;
  }

  try {
    // Build filter for available leases only
    const leaseFilters = availableLeaseIds
      .map(
        (id) =>
          `<condition attribute="array_leaseagreement" operator="eq" value="${id}"/>`,
      )
      .join("");

    // Fetch recurring charges for these leases with "Rent" type
    const fetchXml = `
      <fetch version="1.0" output-format="xml-platform" mapping="logical" distinct="false">
        <entity name="array_recurringcharge">
          <attribute name="array_recurringchargeid"/>
          <attribute name="array_amount"/>
          <attribute name="array_leaseagreement"/>
          <attribute name="array_unit"/>
          <attribute name="createdon"/>
          <filter type="and">
            <condition attribute="statecode" operator="eq" value="0"/>
            <filter type="or">
              ${leaseFilters}
            </filter>
          </filter>
          <link-entity name="array_chargetype" from="array_chargetypeid" to="array_chargetype" link-type="inner" alias="chargetype">
            <attribute name="array_name"/>
            <filter type="and">
              <condition attribute="array_name" operator="eq" value="Rent"/>
            </filter>
          </link-entity>
          <order attribute="createdon" descending="true"/>
        </entity>
      </fetch>
    `;

    const results = await XrmContext.WebApi.retrieveMultipleRecords(
      "array_recurringcharge",
      "?fetchXml=" + encodeURIComponent(fetchXml),
    );

    console.log("&#x1F4B0; Rent charges fetched:", results.entities.length);

    // Map charges to units (get the latest charge per unit)
    results.entities.forEach((charge) => {
      const unitId = charge._array_unit_value;

      // Only store if this unit is in available units and we haven't stored a charge yet
      if (
        unitId &&
        availableUnitIds.includes(unitId) &&
        !unitRentCharges[unitId]
      ) {
        unitRentCharges[unitId] = {
          amount: charge.array_amount || 0,
          chargeType: charge["chargetype.array_name"] || "Rent",
          createdOn: charge.createdon,
        };
      }
    });

    console.log(
      "&#x1F4B0; Unit rent charges mapped:",
      Object.keys(unitRentCharges).length,
    );
    return unitRentCharges;
  } catch (error) {
    console.error(" Error fetching rent charges:", error);
    return unitRentCharges;
  }
}

// Load available units (excluding leased ones)
function loadAvailableUnits(
  propertyId,
  searchTerm,
  availableUnitIds,
  resultsContainer,
  unitRentCharges = {},
) {
  // Build filter for units
  let filter = `_array_property_value eq ${propertyId}`;

  // **UPDATED**: Filter to only show available units
  if (availableUnitIds.length > 0) {
    const unitIdFilters = availableUnitIds
      .map((id) => `array_unitid eq ${id}`)
      .join(" or ");
    filter += ` and (${unitIdFilters})`;
  } else {
    // No available units - show empty state immediately
    resultsContainer.innerHTML = `<div style="text-align: center; padding: 20px; color: #718096;">
                No available units found for the selected lease period<br>
                <small style="color: #a0aec0; margin-top: 8px; display: block;">All units may be leased during this period</small>
            </div>`;
    return;
  }

  // Add search term filter
  if (searchTerm.trim().length > 0) {
    const escapedTerm = searchTerm.trim().replace(/'/g, "''");
    filter += ` and (contains(array_unitname,'${escapedTerm}') or contains(array_unitrecordid,'${escapedTerm}'))`;
  }

  console.log("Final Filter:", filter);

  //  FIX 2: Add Building lookup to expand query
  XrmContext.WebApi.retrieveMultipleRecords(
    "array_unit",
    `?$select=array_unitid,array_unitname,array_unitrecordid,array_unitareasqm,array_bedrooms,array_bathrooms,array_totalrooms,array_coldrent,array_warmrent,array_marketrent,array_securitydeposit,array_location,_array_floor_value,_array_unittype_value,_array_unitsubtypelayout_value,_array_building_value,_array_property_value&$expand=array_Floor($select=array_floorname),array_Building($select=array_buildingname)&$filter=${filter}&$orderby=array_unitname asc`,
  ).then(
    function success(results) {
      allUnitResults = results.entities;

      console.log("Available Units:", results.entities.length);

      if (results.entities.length === 0) {
        resultsContainer.innerHTML = `<div style="text-align: center; padding: 20px; color: #718096;">
                        No available units found${
                          searchTerm
                            ? ` matching "${escapeHtml(searchTerm)}"`
                            : ""
                        } for the selected lease period<br>
                        <small style="color: #a0aec0; margin-top: 8px; display: block;">All units may be leased during this period</small>
                    </div>`;
        return;
      }

      renderUnitCards(results.entities, unitRentCharges);
    },
    function error(err) {
      console.error("Error loading units:", err);
      resultsContainer.innerHTML = `<div style="text-align: center; padding: 20px; color: #f56565;">
                    Error loading units<br>
                    <small style="font-size: 12px;">${escapeHtml(
                      err.message || "Unknown error",
                    )}</small>
                </div>`;
    },
  );
}

// Search Units in Modal
function searchUnitsInModal() {
  const searchTerm = document.getElementById("unitSearchBox").value;
  const propertyId = document.getElementById("propertyId").value;

  if (unitSearchTimeout) {
    clearTimeout(unitSearchTimeout);
  }

  unitSearchTimeout = setTimeout(() => {
    loadUnitsInModal(propertyId, searchTerm);
  }, 300);
}

// Render Unit Cards in Modal
function renderUnitCards(unitEntities, unitRentCharges = {}) {
  const resultsContainer = document.getElementById("unitSearchResults");

  // DEBUG: Log to verify rent charges
  console.log(" Rendering units with rent charges:", {
    unitCount: unitEntities.length,
    rentChargesCount: Object.keys(unitRentCharges).length,
    rentCharges: unitRentCharges,
  });

  let html = `
    <div style="margin-bottom: 16px; padding: 12px; background: #edf2f7; border-radius: 8px; border-left: 4px solid #667eea;">
      <p style="font-size: 14px; color: #4a5568; margin: 0;">
        <strong>${unitEntities.length}</strong> vacant unit${
          unitEntities.length !== 1 ? "s" : ""
        } available. Click on a unit card to select/deselect it.
      </p>
    </div>
    <div class="unit-cards-grid">
  `;

  unitEntities.forEach((unit) => {
    const currentRentData = unitRentCharges[unit.array_unitid];
    const unitType =
      unit["_array_unittype_value@OData.Community.Display.V1.FormattedValue"] ||
      "N/A";
    const unitSubtype =
      unit[
        "_array_unitsubtypelayout_value@OData.Community.Display.V1.FormattedValue"
      ] || "";
    const floor = unit.array_Floor?.array_floorname || "N/A";
    const building =
      unit.array_Building?.array_buildingname ||
      unit["_array_building_value@OData.Community.Display.V1.FormattedValue"] ||
      "N/A";
    const property =
      unit["_array_property_value@OData.Community.Display.V1.FormattedValue"] ||
      "";
    const unitRecordId = unit.array_unitrecordid || "N/A";

    //  CRITICAL: Determine if we have valid previous rent
    const hasPreviousRent =
      currentRentData && currentRentData.amount && currentRentData.amount > 0;

    // DEBUG: Log each unit's rent data
    console.log(
      `&#x1F4CB; Unit "${unit.array_unitname}" (${unit.array_unitid}):`,
      {
        hasRentData: !!currentRentData,
        rentAmount: currentRentData?.amount,
        hasPreviousRent: hasPreviousRent,
        marketRent: unit.array_marketrent,
      },
    );

    // Include all unit data including building name AND previous rent
    const unitData = {
      id: unit.array_unitid,
      name: unit.array_unitname || unit.array_unitrecordid || "Unnamed Unit",
      recordId: unitRecordId,
      type: unitType,
      subtype: unitSubtype,
      area: unit.array_unitareasqm || 0,
      floor: floor,
      building: building,
      buildingId: unit._array_building_value || "",
      property: property,
      bedrooms: unit.array_bedrooms || 0,
      bathrooms: unit.array_bathrooms || 0,
      totalRooms: unit.array_totalrooms || 0,
      coldRent: unit.array_coldrent || 0,
      warmRent: unit.array_warmrent || 0,
      marketRent: unit.array_marketrent || 0,
      securityDeposit: unit.array_securitydeposit || 0,
      location: unit.array_location || "",
      previousRent: hasPreviousRent ? currentRentData.amount : null,
    };

    const isSelected = tempSelectedUnits.find((u) => u.id === unitData.id);

    html += `
      <div class="unit-selection-card ${isSelected ? "selected" : ""}" 
        onclick="toggleUnitSelectionInModal('${unitData.id}')" 
        data-unit-id="${unitData.id}"
        data-unit='${JSON.stringify(unitData).replace(/'/g, "&#39;")}'>
        
        <!-- Card Header -->
        <div class="unit-card-header">
          <div style="flex: 1;">
            <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 6px;">
              <h4 style="font-size: 18px; font-weight: 700; color: #1a202c; margin: 0;">
                ${escapeHtml(unitData.name)}
              </h4>
              <span class="unit-id-badge">ID: ${escapeHtml(unitRecordId)}</span>
            </div>
            <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
              <span class="unit-type-badge">${escapeHtml(unitType)}</span>
              ${
                unitSubtype
                  ? `<span class="unit-subtype-badge">${escapeHtml(
                      unitSubtype,
                    )}</span>`
                  : ""
              }
            </div>
          </div>
          <div class="unit-selection-indicator">
            <div class="selection-checkbox">
              ${isSelected ? "" : ""}
            </div>
          </div>
        </div>
        
        <!--  UPDATED: Key Info Grid - Responsive columns based on data availability -->
        <div class="unit-card-key-info" style="grid-template-columns: repeat(${
          hasPreviousRent ? 3 : 2
        }, 1fr);">
          <!-- AREA -->
          <div class="unit-info-item">
            <span class="info-icon"></span>
            <div>
              <div class="info-label">Area</div>
              <div class="info-value">${unitData.area} sq m</div>
            </div>
          </div>
          
          <!-- MARKET RENT -->
          <div class="unit-info-item">
            <span class="info-icon">&#x1F4B0;</span>
            <div>
              <div class="info-label">Market Rent</div>
              <div class="info-value" style="color: #48bb78;">EUR ${unitData.marketRent.toFixed(
                2,
              )}</div>
            </div>
          </div>
          
          <!--  CURRENT RENT (Previous Rent) - Only show if exists -->
          ${
            hasPreviousRent
              ? `
          <div class="unit-info-item">
            <span class="info-icon">&#x1F3F7;&#xFE0F;</span>
            <div>
              <div class="info-label">Previous Rent</div>
              <div class="info-value" style="color: #667eea;">EUR ${currentRentData.amount.toFixed(
                2,
              )}</div>
              <div style="font-size: 9px; color: #94a3b8; margin-top: 2px;">From current lease</div>
            </div>
          </div>
          `
              : ""
          }
        </div>

        <!-- Details Grid -->
        <div class="unit-card-details">
          ${
            property
              ? `
          <div class="detail-item">
            <span class="detail-label">Property</span>
            <span class="detail-value">${escapeHtml(property)}</span>
          </div>
          `
              : ""
          }
          ${
            building && building !== "N/A"
              ? `
          <div class="detail-item">
            <span class="detail-label">Building</span>
            <span class="detail-value">${escapeHtml(building)}</span>
          </div>
          `
              : ""
          }
          <div class="detail-item">
            <span class="detail-label">Floor</span>
            <span class="detail-value">${escapeHtml(floor)}</span>
          </div>
          ${
            unitData.coldRent > 0
              ? `
          <div class="detail-item">
            <span class="detail-label">Cold Rent</span>
            <span class="detail-value">EUR ${unitData.coldRent.toFixed(2)}</span>
          </div>
          `
              : ""
          }
          ${
            unitData.warmRent > 0
              ? `
          <div class="detail-item">
            <span class="detail-label">Warm Rent</span>
            <span class="detail-value">EUR ${unitData.warmRent.toFixed(2)}</span>
          </div>
          `
              : ""
          }
        </div>
      </div>
    `;
  });

  html += "</div>";
  resultsContainer.innerHTML = html;
}

// Toggle Unit Selection
function toggleUnitSelectionInModal(unitId) {
  const cardElement = document.querySelector(`[data-unit-id="${unitId}"]`);
  if (!cardElement) return;

  const unitData = JSON.parse(cardElement.getAttribute("data-unit"));

  // Check if already selected in temp array
  const existingIndex = tempSelectedUnits.findIndex((u) => u.id === unitId);

  if (existingIndex !== -1) {
    // Deselect - remove from temp array
    tempSelectedUnits.splice(existingIndex, 1);
    cardElement.classList.remove("selected");
    cardElement.querySelector(".selection-checkbox").textContent = "";
  } else {
    // Select - add to temp array
    tempSelectedUnits.push(unitData);
    cardElement.classList.add("selected");
    cardElement.querySelector(".selection-checkbox").textContent = "";
  }
}

// Confirm Unit Selection (OK button click)
async function confirmUnitSelection() {
  // Get units that were newly added
  const newUnits = tempSelectedUnits.filter(
    (tempUnit) => !units.find((u) => u.id === tempUnit.id),
  );

  // Get units that were removed
  const removedUnits = units.filter(
    (unit) => !tempSelectedUnits.find((u) => u.id === unit.id),
  );

  // Remove charges AND deposits for removed units
  removedUnits.forEach((removedUnit) => {
    recurringCharges = recurringCharges.filter(
      (c) => c.unitId !== removedUnit.id,
    );
    deposits = deposits.filter((d) => d.unitId !== removedUnit.id);
  });

  //  CRITICAL: Update the main units array
  units = [...tempSelectedUnits];
  updateTotalUnitsArea();

  console.log(
    " units after confirmation:",
    units.map((u) => ({ name: u.name, id: u.id, area: u.area })),
  );

  // Update unit display
  renderUnits();

  // Update field state for unit lookup
  const unitDisplay = document.getElementById("unitDisplay");
  if (units.length > 0) {
    unitDisplay.value = `${units.length} unit${units.length !== 1 ? "s" : ""} selected`;
  } else {
    unitDisplay.value = "";
  }
  updateFieldState(unitDisplay);

  // Close modal first for responsive UI
  closeModal("unitLookupModal");

  // Show notification
  if (newUnits.length > 0 || removedUnits.length > 0) {
    showNotification(
      `Selection updated: ${units.length} unit${units.length !== 1 ? "s" : ""} selected`,
      "success",
    );
  } else {
    showNotification("No changes made", "info");
  }

  //  EAGERLY load & auto-populate unit recurring charges for ALL units
  if (newUnits.length > 0 || removedUnits.length > 0) {
    chargesLoadedInitially = false;
    originalChargesFromDataverse = [];
    await loadAndAutoPopulateAllUnitCharges();
  }

  // Render charges grid and deposits (now fully populated)
  renderAllChargesGrid();
  renderDeposits();
}

//Total Area in Unit
function updateTotalUnitsArea() {
  totalUnitsAreaValue = units.reduce((sum, u) => {
    return sum + (Number(u.area) || 0);
  }, 0);

  const totalAreaGroup = document.getElementById("totalUnitsAreaGroup");
  const totalAreaInput = document.getElementById("totalUnitsArea");
  const totalAreaHint = document.getElementById("totalAreaHint");
  if (!totalAreaGroup || !totalAreaInput) return;

  const leaseTermTypeSelect = document.getElementById("leaseTermType");
  const selectedOption =
    leaseTermTypeSelect?.options[leaseTermTypeSelect.selectedIndex];
  const isMonthToMonth =
    selectedOption &&
    selectedOption.textContent.toLowerCase().includes("month-to-month");

  if (units.length === 0 && !isMonthToMonth) {
    totalAreaGroup.style.display = "none";
    totalAreaInput.value = "";
    return;
  }

  //  NEW: Clear area when last unit removed in Month-to-Month
  if (units.length === 0 && isMonthToMonth) {
    totalAreaGroup.style.display = "block";
    totalAreaInput.value = "";
    totalAreaInput.readOnly = false;
    totalAreaInput.style.background = "";
    totalAreaInput.style.cursor = "";
    totalAreaInput.placeholder = "Enter total area manually";
    if (totalAreaHint) {
      totalAreaHint.textContent =
        "Enter total area manually - units are optional for Month-to-Month leases";
      totalAreaHint.style.color = "#059669";
    }
    return;
  }

  totalAreaGroup.style.display = "block";

  if (isMonthToMonth) {
    if (units.length > 0) {
      // Unit selected in Month-to-Month - lock and auto-fill from unit area
      totalAreaInput.readOnly = true;
      totalAreaInput.style.background = "#f1f5f9";
      totalAreaInput.style.cursor = "not-allowed";
      totalAreaInput.placeholder = "Auto-calculated from selected units";
      totalAreaInput.value = totalUnitsAreaValue.toFixed(2);
      if (totalAreaHint) {
        totalAreaHint.textContent = "Auto-calculated from selected units";
        totalAreaHint.style.color = "#94a3b8";
      }
    } else {
      // No units - allow manual entry
      totalAreaInput.readOnly = false;
      totalAreaInput.style.background = "";
      totalAreaInput.style.cursor = "";
      totalAreaInput.placeholder = "Enter total area manually";
      if (totalAreaHint) {
        totalAreaHint.textContent =
          "Enter total area manually - units are optional for Month-to-Month leases";
        totalAreaHint.style.color = "#059669";
      }
    }
  } else {
    totalAreaInput.readOnly = true;
    totalAreaInput.style.background = "#f1f5f9";
    totalAreaInput.style.cursor = "not-allowed";
    totalAreaInput.placeholder = "Auto-calculated from selected units";
    totalAreaInput.value = totalUnitsAreaValue.toFixed(2);
    if (totalAreaHint) {
      totalAreaHint.textContent = "Auto-calculated from selected units";
      totalAreaHint.style.color = "#94a3b8";
    }
  }
}

// Sync the "Select Unit" field text with the `units` array.
function _syncUnitDisplay() {
  const unitDisplay = document.getElementById("unitDisplay");
  if (!unitDisplay) return;
  if (units.length > 0) {
    unitDisplay.value = `${units.length} unit${units.length !== 1 ? "s" : ""} selected`;
    unitDisplay.setAttribute("data-user-input", "true");
  } else {
    unitDisplay.value = "";
    unitDisplay.removeAttribute("data-user-input");
  }
  if (typeof updateFieldState === "function") updateFieldState(unitDisplay);
}

// Persistent notice under the unit field for document unit identifiers that
// could not be matched to an active unit (pass [] to remove it).
function _showUnitNotFoundHint(missingIds) {
  const old = document.getElementById("unitNotFoundAiHint");
  if (old) old.remove();
  if (!missingIds || !missingIds.length) return;
  const unitDisplay = document.getElementById("unitDisplay");
  if (!unitDisplay) return;
  const hint = document.createElement("div");
  hint.id = "unitNotFoundAiHint";
  hint.style.cssText =
    "margin-top:6px;padding:8px 10px;border:1px solid #E3B341;background:#FEF6E0;border-radius:6px;font-size:12px;line-height:1.45;color:#5c4400;";
  hint.innerHTML =
    "<strong>Unit from the document not found in the system:</strong> " +
    escapeHtml(missingIds.join(", ")) +
    ".<br><span style=\"color:#7a5a00;\">No active unit with this number exists" +
    (document.getElementById("propertyId")?.value
      ? " for the selected property"
      : "") +
    ". Select the correct unit from the dropdown, or create the unit first.</span>";
  (unitDisplay.closest(".form-group") || unitDisplay.parentNode).appendChild(
    hint,
  );
}

// Render units with modern card design
function renderUnits() {
  const container = document.getElementById("unitsContainer");
  const countElement = document.getElementById("selectedUnitsCount");

  // Update count
  if (countElement) {
    countElement.textContent = `${units.length} unit${
      units.length !== 1 ? "s" : ""
    } selected`;
  }

  // Keep the dropdown text in sync with the actual selection. Several paths
  // reset `units` (date change, property change/clear, reset) without touching
  // #unitDisplay, which left "1 unit selected" over an empty list.
  _syncUnitDisplay();

  if (units.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">&#x1F3E2;</span>
        <p>No units selected yet</p>
        <p class="empty-hint">Select units from the dropdown above</p>
      </div>
    `;
  } else {
    container.innerHTML = `<div class="records-list" style="display: flex; flex-direction: column; gap: 20px; width: 100%;">${units
      .map((unit) => {
        //  Check if previous rent exists and is valid
        const hasPreviousRent = unit.previousRent && unit.previousRent > 0;

        // DEBUG: Log rendering
        console.log(` Rendering unit "${unit.name}":`, {
          hasPreviousRent: hasPreviousRent,
          previousRent: unit.previousRent,
          marketRent: unit.marketRent,
        });

        // Single-line key-info: one column per visible field so optional
        // fields (Building/Previous rent/Security deposit) stay inline.
        const keyInfoCount =
          5 +
          (unit.building ? 1 : 0) +
          (hasPreviousRent ? 1 : 0) +
          (unit.securityDeposit ? 1 : 0);

        return `
      <div class="modern-unit-card">
        <div class="unit-card-header">
          <div class="record-title">
            <span style="width:30px;height:30px;border-radius:8px;background:var(--blue-l);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#1C6BD4" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3h18v18H3z"/><path d="M3 9h18"/><path d="M9 21V9"/></svg>
            </span>
            <span>${escapeHtml(unit.name)}</span>
            ${unit.recordId && unit.recordId !== "N/A" ? `<span style="font-size:11px;color:var(--blue);font-weight:700;background:var(--blue-l);padding:3px 10px;border-radius:10px;">ID: ${escapeHtml(unit.recordId)}</span>` : ""}
            ${unit.subtype ? `<span class="unit-subtype-badge">${escapeHtml(unit.subtype)}</span>` : ""}
          </div>
          <button onclick="deleteUnit('${unit.id}')" title="Remove unit"
            style="background:var(--red-l);border:1px solid var(--red-mid);border-radius:6px;cursor:pointer;color:var(--red);display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;padding:4px 9px;">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg> Remove
          </button>
        </div>
        <div class="unit-card-key-info" style="grid-template-columns:repeat(${keyInfoCount},minmax(0,1fr));">
          <div class="unit-info-item">
            <div class="info-label">Area</div>
            <div class="info-value" style="color:var(--blue);">${unit.area != null ? unit.area : "&mdash;"} <span style="font-size:10px;font-weight:600;color:var(--sub);">sq m</span></div>
          </div>
          <div class="unit-info-item">
            <div class="info-label">Market rent</div>
            <div class="info-value" style="color:var(--teal);">${unit.marketRent && unit.marketRent > 0 ? "&euro;" + unit.marketRent.toFixed(2) : "&mdash;"}</div>
          </div>
          <div class="unit-info-item">
            <div class="info-label">Unit type</div>
            <div class="info-value" style="font-size:12px;font-weight:600;">${escapeHtml(unit.type || "-")}</div>
          </div>
          <div class="unit-info-item">
            <div class="info-label">Property</div>
            <div class="info-value" style="font-size:12px;font-weight:600;">${escapeHtml(unit.property || "-")}</div>
          </div>
          <div class="unit-info-item">
            <div class="info-label">Floor</div>
            <div class="info-value" style="font-size:12px;font-weight:600;">${escapeHtml(unit.floor || "-")}</div>
          </div>
          ${unit.building ? `<div class="unit-info-item"><div class="info-label">Building</div><div class="info-value" style="font-size:12px;font-weight:600;">${escapeHtml(unit.building)}</div></div>` : ""}
          ${hasPreviousRent ? `<div class="unit-info-item"><div class="info-label">Previous rent</div><div class="info-value" style="font-size:12px;font-weight:700;color:var(--purple);">&euro;${unit.previousRent.toFixed(2)}</div></div>` : ""}
          ${unit.securityDeposit ? `<div class="unit-info-item"><div class="info-label">Security deposit</div><div class="info-value" style="font-size:12px;font-weight:700;color:var(--amber);">&euro;${unit.securityDeposit.toFixed(2)}</div></div>` : ""}
        </div>
      </div>
      `;
      })
      .join("")}</div>`;
  }
  if (units.length === 0) {
    updateTotalUnitsArea();
  }
}

// Delete unit
function deleteUnit(id) {
  showDeleteConfirm(
    "Remove Unit",
    "Remove this unit and all associated charges & deposits?",
    () => {
      units = units.filter((u) => u.id !== id);
      recurringCharges = recurringCharges.filter((c) => c.unitId !== id);
      deposits = deposits.filter((d) => d.unitId !== id);

      // Reset charges loaded flag if all units are removed
      if (units.length === 0) {
        chargesLoadedInitially = false;
      }

      //  Update unit display field
      const unitDisplay = document.getElementById("unitDisplay");
      if (unitDisplay) {
        if (units.length > 0) {
          unitDisplay.value = `${units.length} unit${units.length !== 1 ? "s" : ""} selected`;
        } else {
          unitDisplay.value = "";
          unitDisplay.removeAttribute("data-user-input");
        }
        updateFieldState(unitDisplay);
      }

      updateTotalUnitsArea();
      renderUnits();
      renderRecurringCharges();
      renderDeposits();
      showNotification("Unit removed", "success");
    },
  );
}

//create lease association record
async function saveLeaseUnitAssociations(leaseId) {
  if (!leaseId || !units || units.length === 0) {
    console.log("  No units to associate");
    return;
  }

  console.log(" Creating associations for", units.length, "units");

  const leaseStartDate = document.getElementById("startDate").value;
  const leaseEndDate = document.getElementById("endDate").value || null;

  try {
    const createPromises = units.map((unit) => {
      const payload = {
        //  Use capital letters like in your working deposit code
        "array_LeaseAgreement@odata.bind": `/array_leaseagreements(${leaseId})`,
        "array_Unit@odata.bind": `/array_units(${unit.id})`,
        array_startdate: leaseStartDate,
      };

      //  Capture building associated with each unit in the association record
      if (unit.buildingId && unit.buildingId.trim() !== "") {
        payload["array_Building@odata.bind"] =
          `/array_buildings(${unit.buildingId.trim()})`;
        console.log(
          "&#x1F3E2; Building set on unit lease association:",
          unit.buildingId.trim(),
        );
      }

      // Only add end date if it exists
      if (leaseEndDate) {
        payload.array_enddate = leaseEndDate;
      }

      console.log(" Creating association:", payload);

      return XrmContext.WebApi.createRecord(
        "array_leaseunitassociation",
        payload,
      );
    });

    const results = await Promise.all(createPromises);
    console.log(" Created", results.length, "associations");
    return results;
  } catch (error) {
    console.error(" Error creating associations:", error);
    throw error;
  }
}

// Update units with current lease - returns Promise
function updateUnitsWithLease(leaseAgreementId) {
  return new Promise((resolve) => {
    if (units.length === 0) {
      resolve();
      return;
    }

    const leaseStartDate = document.getElementById("startDate").value;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const leaseStart = leaseStartDate ? new Date(leaseStartDate) : null;
    if (leaseStart) leaseStart.setHours(0, 0, 0, 0);

    // Set tenant only if lease start date is today or in the past
    const isFutureStart = leaseStart ? leaseStart > today : false;

    const tenantId = document.getElementById("tenantId").value;
    const tenantType = document.getElementById("tenantType").value;

    var unitsUpdated = 0;
    var unitsToUpdate = units.length;

    units.forEach(function (unit) {
      var unitUpdateRecord = {};

      // Set current lease ONLY if lease start date is today or in the past
      const isValidLeaseGuidUnit =
        typeof leaseAgreementId === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          leaseAgreementId.trim(),
        );

      if (isValidLeaseGuidUnit && !isFutureStart) {
        unitUpdateRecord["array_CurrentLease@odata.bind"] =
          "/array_leaseagreements(" + leaseAgreementId.trim() + ")";
        console.log(
          ` Setting current lease on unit "${unit.name}" - lease start date (${leaseStartDate}) is today or in the past`,
        );
      } else if (isValidLeaseGuidUnit && isFutureStart) {
        console.log(
          `>> Skipping current lease on unit "${unit.name}" - lease start date (${leaseStartDate}) is in the future`,
        );
      }

      // Set current tenant ONLY if lease start date is today or in the past
      if (!isFutureStart && tenantId && tenantType) {
        if (tenantType === "account") {
          unitUpdateRecord["array_CurrentTenant_account@odata.bind"] =
            "/accounts(" + tenantId + ")";
        } else if (tenantType === "contact") {
          unitUpdateRecord["array_CurrentTenant_contact@odata.bind"] =
            "/contacts(" + tenantId + ")";
        }
        console.log(
          ` Setting current tenant on unit "${unit.name}" - lease start date (${leaseStartDate}) is today or in the past`,
        );
      } else if (isFutureStart) {
        console.log(
          `>> Skipping current tenant on unit "${unit.name}" - lease start date (${leaseStartDate}) is in the future`,
        );
      } else {
        console.log(
          `  Skipping current tenant on unit "${unit.name}" - no tenant or type provided`,
        );
      }

      XrmContext.WebApi.updateRecord(
        "array_unit",
        unit.id,
        unitUpdateRecord,
      ).then(
        function success(result) {
          unitsUpdated++;
          console.log(` Unit updated: ${unit.name}`);
          if (unitsUpdated === unitsToUpdate) resolve();
        },
        function error(unitError) {
          console.error(` Error updating unit "${unit.name}":`, unitError);
          unitsUpdated++;
          if (unitsUpdated === unitsToUpdate) resolve();
        },
      );
    });
  });
}

//  Handle unit selection change to update billable area
function handleUnitSelectionForBillableArea() {
  const unitSelect = document.getElementById("chargeUnitSelect");
  const billableAreaField = document.getElementById("chargeBillableArea");

  const selectedUnitId = unitSelect.value;

  if (selectedUnitId && selectedUnitId.trim() !== "") {
    // Unit selected - populate with selected unit's area
    const selectedUnit = units.find((u) => u.id === selectedUnitId);
    if (selectedUnit && selectedUnit.area) {
      billableAreaField.value = selectedUnit.area;
      billableAreaField.setAttribute("data-user-input", "true");
      console.log(
        ` Billable area set to selected unit area: ${selectedUnit.area} sq m`,
      );
    }
  } else {
    // No unit selected - populate with total area
    billableAreaField.value = totalUnitsAreaValue.toFixed(2);
    billableAreaField.setAttribute("data-user-input", "true");
    console.log(
      ` Billable area set to total area: ${totalUnitsAreaValue.toFixed(
        2,
      )} sq m`,
    );
  }

  updateFieldState(billableAreaField);
}

//  LOAD AND AUTO-POPULATE all unit recurring charges for every selected unit.
// Called eagerly from confirmUnitSelection so charges are ready before Stage 3 is visited.
async function loadAndAutoPopulateAllUnitCharges() {
  if (units.length === 0) return;

  console.log(
    " [loadAndAutoPopulateAllUnitCharges] Loading for",
    units.length,
    "unit(s)...",
  );

  // Always load all required lookup data fresh
  try {
    const [
      chargeTypes,
      currencies,
      frequencies,
      vats,
      dueDateRules,
      rateRules,
    ] = await Promise.all([
      loadChargeTypes(),
      loadCurrencies(),
      loadFrequencies(),
      loadVATs(),
      loadDueDateRule(),
      loadRateRules(),
    ]);
    window.chargeTypes = chargeTypes;
    window.currencies = currencies;
    window.frequencies = frequencies;
    window.vats = vats;
    window.dueDateRules = dueDateRules;
    window.rateRules = rateRules;
    console.log(" Lookup data loaded:", {
      currencies: currencies.length,
      dueDateRules: dueDateRules.length,
      rateRules: rateRules.length,
    });
  } catch (e) {
    console.error(" Failed to load lookup data:", e);
  }

  // Fetch unit recurring charges for every unit in parallel
  const chargesPromises = units.map((unit) =>
    loadUnitRecurringCharges(unit.id),
  );
  const allChargesArrays = await Promise.all(chargesPromises);

  // Flatten
  const freshFromDataverse = [];
  allChargesArrays.forEach((charges, idx) => {
    console.log(
      ` Unit "${units[idx].name}": ${charges.length} charge(s) loaded`,
    );
    freshFromDataverse.push(...charges);
  });
  originalChargesFromDataverse = freshFromDataverse;

  // Merge: keep manually-added charges, replace isExisting charges with fresh ones
  const manualCharges = recurringCharges.filter((c) => !c.isExisting);
  recurringCharges = [
    ...manualCharges,
    ...JSON.parse(JSON.stringify(freshFromDataverse)),
  ];

  console.log(" recurringCharges after merge:", {
    fromDataverse: freshFromDataverse.length,
    manual: manualCharges.length,
    total: recurringCharges.length,
  });

  // Auto-populate all isExisting charges now
  await autoPopulateUnitRecurringCharges();

  chargesLoadedInitially = true;
  console.log(
    " [loadAndAutoPopulateAllUnitCharges] Complete - charges ready for grid",
  );
}

//  AUTO-POPULATE all unit recurring charges (isExisting) with lease dates, currency, bank account etc.
// Called immediately after charges are loaded from Dataverse - no manual edit needed.
async function autoPopulateUnitRecurringCharges() {
  const leaseStartDate = document.getElementById("startDate")?.value || "";
  const leaseEndDate = document.getElementById("endDate")?.value || "";
  const todayStr = formatDateForInput(new Date());

  // Resolve Due Date Rule value: "as of the issue of the sales document"
  let defaultDueDateRuleValue = "";
  if (window.dueDateRules && window.dueDateRules.length > 0) {
    const targetLabel = "as of the issue of the sales document";
    const matched = window.dueDateRules.find((r) => {
      const lbl = r.Label?.UserLocalizedLabel?.Label || "";
      return lbl.toLowerCase().trim() === targetLabel;
    });
    defaultDueDateRuleValue = matched
      ? String(matched.Value)
      : String(window.dueDateRules[0].Value);
  }

  // Resolve Rate Rule: "of the date of issue"
  let defaultRateRuleId = "";
  let defaultRateRuleName = "";
  if (window.rateRules && window.rateRules.length > 0) {
    const targetRule = "of the date of issue";
    const matched = window.rateRules.find(
      (r) =>
        r.array_rulename &&
        r.array_rulename.toLowerCase().trim() === targetRule,
    );
    if (matched) {
      defaultRateRuleId = matched.array_exchangerateselectionrulesid;
      defaultRateRuleName = matched.array_rulename;
    }
  }

  // Build a cache of bank accounts per currency to avoid redundant API calls
  const bankAccountCache = {};
  //  Bank accounts must belong to the property selected in Stage 1 (mirrors the manual picker)
  const _autoPropertyId = document.getElementById("propertyId")?.value || "";

  for (let i = 0; i < recurringCharges.length; i++) {
    const charge = recurringCharges[i];
    if (!charge.isExisting) continue; // only auto-populate unit recurring charges

    // 1. Dates
    charge.startDate = leaseStartDate;
    charge.endDate = leaseEndDate;

    // 2. Invoice Generation Date = Today
    charge.invoiceGenerationDate = todayStr;

    // 3. Due Date Rule default
    if (!charge.dueDateRule) {
      charge.dueDateRule = defaultDueDateRuleValue;
    }

    // 4. Rate Rule (Exchange Rule) default
    if (!charge.rateRule && defaultRateRuleId) {
      charge.rateRule = defaultRateRuleId;
      charge.rateRuleName = defaultRateRuleName;
    }

    // 5. Currency - already fetched from unit recurring charge; enrich symbol/code
    if (charge.currency && window.currencies && window.currencies.length > 0) {
      const currObj = window.currencies.find(
        (c) => c.transactioncurrencyid === charge.currency,
      );
      if (currObj) {
        charge.currencyName = `${currObj.currencyname} (${currObj.isocurrencycode})`;
        charge.currencySymbol = currObj.currencysymbol || "";
        charge.currencyCode = currObj.isocurrencycode || "";
      }
    } else if (!charge.currency) {
      // Fallback: use the default currency (exchange rate = 1)
      if (window.currencies && window.currencies.length > 0) {
        const defCurr = window.currencies.find(
          (c) => parseFloat(c.exchangerate) === 1.0,
        );
        if (defCurr) {
          charge.currency = defCurr.transactioncurrencyid;
          charge.currencyName = `${defCurr.currencyname} (${defCurr.isocurrencycode})`;
          charge.currencySymbol = defCurr.currencysymbol || "";
          charge.currencyCode = defCurr.isocurrencycode || "";
        }
      }
    }

    // 6. Billable Area - use unit's own area; fall back to total area
    if (!charge.billableArea || charge.billableArea === 0) {
      if (charge.unitArea && charge.unitArea > 0) {
        charge.billableArea = charge.unitArea;
      } else {
        const unitObj = units.find((u) => u.id === charge.unitId);
        if (unitObj && unitObj.area) {
          charge.billableArea = Number(unitObj.area) || 0;
        } else if (totalUnitsAreaValue > 0) {
          charge.billableArea = totalUnitsAreaValue;
        }
      }
    }

    // 7. Bank Account - fetch once per currency and cache
    if (charge.currency && !charge.bankAccount) {
      if (bankAccountCache[charge.currency] === undefined) {
        try {
          let _baFilter = `statecode eq 0 and _array_currency_value eq ${charge.currency}`;
          if (_autoPropertyId) {
            _baFilter += ` and _array_property_value eq ${_autoPropertyId}`;
          }
          const results = await XrmContext.WebApi.retrieveMultipleRecords(
            "array_bankaccount",
            `?$select=array_bankaccountid,array_bankaccountnumber&$filter=${_baFilter}&$orderby=createdon asc&$top=1`,
          );
          bankAccountCache[charge.currency] =
            results.entities.length > 0 ? results.entities[0] : null;
        } catch (e) {
          console.warn(
            "  Bank account fetch failed for currency:",
            charge.currency,
            e,
          );
          bankAccountCache[charge.currency] = null;
        }
      }
      const bankAcc = bankAccountCache[charge.currency];
      if (bankAcc) {
        charge.bankAccount = bankAcc.array_bankaccountid;
        charge.bankAccountName =
          bankAcc.array_bankaccountnumber || "Bank Account";
      }
    }

    // 8. Mark as fully populated - subsequent edits use saved values
    charge.needsAutoPopulate = false;

    console.log(
      ` Auto-populated unit recurring charge: "${charge.name}" | Start: ${charge.startDate} | End: ${charge.endDate} | Currency: ${charge.currencyCode} | Bank: ${charge.bankAccountName || "none"}`,
    );
  }
}

//------------------------------------------------------------------STAGE 3 - RECURRING CHARGES FUNCTIONS ---------------------------------------------------------------------//

// Render Stage 3 - Recurring Charges (Load once from Dataverse, then work with copy)
async function renderRecurringCharges() {
  const container = document.getElementById("allChargesContainer");
  if (!container) {
    console.warn("allChargesContainer not found");
    return;
  }

  if (units.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">&#x1F4CB;</span>
        <p>No units added yet</p>
        <p class="empty-hint">Please add units in Stage 2 first</p>
      </div>`;
    return;
  }

  // If charges were already loaded and auto-populated (by confirmUnitSelection), just render
  if (chargesLoadedInitially) {
    console.log(
      " renderRecurringCharges: charges already loaded - rendering grid",
    );
    renderAllChargesGrid();
    return;
  }

  // Fallback: charges not yet loaded (e.g. user navigated directly to Stage 3)
  container.innerHTML = `
    <div style="text-align: center; padding: 40px; color: #667eea;">
      <div class="loader" style="margin: 0 auto 16px;"></div>
      <p>Loading recurring charges...</p>
    </div>`;

  try {
    await loadAndAutoPopulateAllUnitCharges();
    renderAllChargesGrid();
  } catch (error) {
    console.error(" Error in renderRecurringCharges:", error);
    container.innerHTML = `
      <div style="text-align: center; padding: 40px; color: #f56565;">
        <p> Error loading recurring charges</p>
        <p style="font-size: 12px; margin-top: 8px;">${escapeHtml(error.message || "Unknown error")}</p>
        <button class="btn-add-large" onclick="forceReloadCharges()" style="margin-top: 16px;"> Retry</button>
      </div>`;
  }
}

// Render all charges in a single grid
function renderAllChargesGrid() {
  _renderAllChargesGridCore();
  // After any charge add/edit/delete, auto-create/sync the default collateral
  // rule from the current charges (no-op if AI autofill is pending or a
  // non-auto rule already owns the section).
  try {
    if (typeof autoCreateCollateralFromCharges === "function") {
      autoCreateCollateralFromCharges();
    }
  } catch (e) {
    console.error("autoCreateCollateralFromCharges failed:", e);
  }
}

function _renderAllChargesGridCore() {
  const container = document.getElementById("allChargesContainer");
  if (!container) {
    console.error(" allChargesContainer not found!");
    return;
  }

  if (recurringCharges.length === 0) {
    console.log(" No charges to display, showing empty state");
    container.innerHTML = `
            <div class="empty-state">
                <span class="empty-icon">&#x1F4B0;</span>
                <p>No recurring charges added yet</p>
                <p class="empty-hint">Click "Add New Charge" button above to create your first charge</p>
            </div>
        `;
    return;
  }
  const totalsByCurrency = {};
  recurringCharges.forEach((c) => {
    if (!totalsByCurrency[c.currencyCode]) {
      totalsByCurrency[c.currencyCode] = {
        symbol: c.currencySymbol || "",
        total: 0,
      };
    }
    totalsByCurrency[c.currencyCode].total += c.amount;
  });

  const totalsHtml = Object.values(totalsByCurrency)
    .map((t) => `${t.symbol}${t.total.toFixed(2)}`)
    .join(" | ");

  let html = `
        <div class="charges-table-wrapper">
            <table class="charges-table">
                <thead>
                    <tr>
                        <th>Unit</th>
                        <th>Charge name</th>
                        <th>Type</th>
                        <th style="text-align:right;">Amount</th>
                        <th>Frequency</th>
                        <th>Start date</th>
                        <th style="text-align:center;width:90px;">Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${recurringCharges
                      .map((charge) => {
                        const chargeDataStr = JSON.stringify(charge)
                          .replace(/'/g, "&#39;")
                          .replace(/"/g, "&quot;");
                        const statusTag =
                          (charge.needsCompletion
                            ? '<span class="tag status-incomplete">Incomplete</span>'
                            : "") +
                          (charge._defaulted &&
                          Object.keys(charge._defaulted).length
                            ? ' <span class="tag" title="Not stated in the document - defaulted from the lease. Please verify." style="background:#FEF6E0;color:#7a5a00;border:1px solid #E3B341;">Defaulted</span>'
                            : "");
                        return `
                        <tr>
                            <td style="color:var(--sub);font-weight:600;">${escapeHtml(charge.unitName || "-")}</td>
                            <td>
                                <div style="font-weight:700;color:var(--text);">${escapeHtml(charge.name)}</div>
                                ${statusTag ? `<div style="margin-top:4px;">${statusTag}</div>` : ""}
                            </td>
                            <td style="color:var(--sub);">${escapeHtml(charge.chargeTypeName || "-")}</td>
                            <td style="text-align:right;">
                                <div style="font-weight:700;color:var(--text);">${charge.currencySymbol || ""}${charge.amount.toFixed(2)}</div>
                                ${charge.vatName ? `<div style="font-size:11px;color:var(--hint);margin-top:2px;">VAT: ${escapeHtml(charge.vatName)}</div>` : ""}
                            </td>
                            <td style="color:var(--sub);">${escapeHtml(charge.frequencyName || "-")}</td>
                            <td style="color:var(--hint);">
                                <div>${charge.startDate || "-"}</div>
                                ${charge.endDate ? `<div style="margin-top:2px;">${charge.endDate}</div>` : ""}
                                ${charge.dueInDays ? `<div style="margin-top:4px;font-size:10px;color:var(--hint);">Due: ${charge.dueInDays} days</div>` : ""}
                            </td>
                            <td style="text-align:center;white-space:nowrap;">
                                <span class="record-actions" style="justify-content:center;">
                                  <button class="action-edit" onclick='editRecurringCharge(${chargeDataStr})' title="Edit charge"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
                                  <button class="action-delete" onclick="deleteRecurringCharge('${charge.id}')" title="Delete charge"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg></button>
                                </span>
                            </td>
                        </tr>
                    `;
                      })
                      .join("")}
                </tbody>
            </table>
        </div>
        <div class="table-totals"><span>Total: <strong>${totalsHtml}</strong></span></div>
    `;

  container.innerHTML = html;
}

// Force reload charges (for retry button)
function forceReloadCharges() {
  console.log(" Force reloading charges...");
  chargesLoadedInitially = false;
  recurringCharges = recurringCharges.filter((c) => !c.isExisting); // Keep manually added charges
  originalChargesFromDataverse = [];
  renderRecurringCharges();
}

async function _createPartialChargesFromAutofill() {
  const _pcaList = window._pendingChargesAutofill;
  if (!_pcaList || !_pcaList.length) return;
  window._pendingChargesAutofill = null;

  // Ensure lookup caches are loaded so currency / charge type / frequency / VAT / rules
  // resolve. Without this, autofill at Stage 3 runs before the lookups load and the
  // currency (and therefore the bank account) silently fails to populate.
  if (!window.currencies || !window.chargeTypes || !window.frequencies) {
    try {
      const [
        chargeTypes,
        currencies,
        frequencies,
        vats,
        dueDateRules,
        rateRules,
      ] = await Promise.all([
        loadChargeTypes(),
        loadCurrencies(),
        loadFrequencies(),
        loadVATs(),
        loadDueDateRule(),
        loadRateRules(),
      ]);
      window.chargeTypes = chargeTypes;
      window.currencies = currencies;
      window.frequencies = frequencies;
      window.vats = vats;
      window.dueDateRules = dueDateRules;
      window.rateRules = rateRules;
    } catch (e) {
      console.error("Autofill: failed to load charge lookup data:", e);
    }
  }

  // Cache bank accounts per currency to avoid redundant calls across charges.
  const _bankCache = {};
  // Cache invoice-type config (per property+chargeType) and prefix (per invoice
  // type) so multiple charges don't re-run the same Dataverse lookups.
  const _invoiceCfgCache = {};
  const _prefixCache = {};

  const _matchText = (arr, textKey, val) =>
    val
      ? arr.find((r) => (r[textKey] || "").toLowerCase() === val.toLowerCase())
      : null;
  // Normalize for comparison: collapse whitespace, trim, lowercase.
  const _normLabel = (s) =>
    String(s || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  // Read an option's label, falling back from UserLocalizedLabel to LocalizedLabels
  // (some choices only populate the latter, which previously broke matching).
  const _optionLabel = (r) =>
    r?.Label?.UserLocalizedLabel?.Label ||
    r?.Label?.LocalizedLabels?.[0]?.Label ||
    "";
  const _matchLabel = (arr, val) => {
    const target = _normLabel(val);
    if (!target) return null;
    return (
      (arr || []).find((r) => _normLabel(_optionLabel(r)) === target) || null
    );
  };
  const _toDateInput = (s) => {
    const d = new Date(s);
    if (isNaN(d)) return "";
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  const _leaseTermTypeSel = document.getElementById("leaseTermType");
  const _isShortTerm =
    _leaseTermTypeSel &&
    (
      _leaseTermTypeSel.options[_leaseTermTypeSel.selectedIndex]?.textContent ||
      ""
    )
      .toLowerCase()
      .includes("month-to-month");

  for (const _pca of _pcaList) {
    const _txt = (k) => (_pca[k] ? String(_pca[k]).trim() : "");

    // Resolve chargeType
    const _ctObj = resolveChargeType(
      window.chargeTypes || [],
      _txt("chargeType"),
    );
    const chargeType = _ctObj ? _ctObj.array_chargetypeid : "";
    const chargeTypeName = _ctObj ? _ctObj.array_name : _txt("chargeType");

    // Resolve currency
    const _currTxt = _txt("chargeCurrency");
    const _currObj = _currTxt
      ? (window.currencies || []).find(
          (c) =>
            c.isocurrencycode.toLowerCase() === _currTxt.toLowerCase() ||
            c.currencyname.toLowerCase() === _currTxt.toLowerCase(),
        )
      : null;
    const currency = _currObj ? _currObj.transactioncurrencyid : "";
    const currencyName = _currObj ? _currObj.currencyname : _currTxt;
    const currencyCode = _currObj
      ? (_currObj.isocurrencycode || "").toUpperCase()
      : "";
    const currencySymbol = _currObj ? _currObj.currencysymbol || "" : "";

    // Resolve the bank account from the currency (mirrors manual selection behaviour),
    // cached per currency. EUR/PLN are the common cases.
    let bankAccount = "";
    let bankAccountName = "";
    if (currency) {
      if (_bankCache[currency] === undefined) {
        try {
          const _baRes = await XrmContext.WebApi.retrieveMultipleRecords(
            "array_bankaccount",
            `?$select=array_bankaccountid,array_bankaccountnumber&$filter=statecode eq 0 and _array_currency_value eq ${currency}&$orderby=createdon asc&$top=1`,
          );
          _bankCache[currency] = _baRes.entities.length
            ? _baRes.entities[0]
            : null;
        } catch (e) {
          console.warn(
            "Autofill: bank account lookup failed for currency",
            currency,
            e,
          );
          _bankCache[currency] = null;
        }
      }
      const _ba = _bankCache[currency];
      if (_ba) {
        bankAccount = _ba.array_bankaccountid;
        bankAccountName = _ba.array_bankaccountnumber || "Bank Account";
      }
    }

    // Resolve frequency - key stored as "Frequency" (capital F)
    const _freqObj = _matchLabel(window.frequencies || [], _txt("Frequency"));
    const frequency = _freqObj ? _freqObj.Value : "";
    const frequencyName = _freqObj
      ? _freqObj.Label && _freqObj.Label.UserLocalizedLabel
        ? _freqObj.Label.UserLocalizedLabel.Label
        : ""
      : _txt("Frequency");

    // Resolve VAT
    const _vatTxt = _txt("vatPercent");
    const _vatObj = _vatTxt
      ? (window.vats || []).find(
          (v) =>
            (
              v.array_name + (v.array_vat ? ` (${v.array_vat}%)` : "")
            ).toLowerCase() === _vatTxt.toLowerCase() ||
            v.array_name.toLowerCase() === _vatTxt.toLowerCase(),
        )
      : null;
    const vat = _vatObj ? _vatObj.array_vatid : "";
    const vatName = _vatObj
      ? _vatObj.array_name +
        (_vatObj.array_vat ? ` (${_vatObj.array_vat}%)` : "")
      : _vatTxt;

    // Resolve dueDateRule
    const _ddrObj = _matchLabel(window.dueDateRules || [], _txt("dueDateRule"));
    const dueDateRule = _ddrObj ? _ddrObj.Value : "";

    // Resolve exchangeRateRule
    const _rrTxt = _txt("exchangeRateRule");
    const _rrObj = _rrTxt
      ? (window.rateRules || []).find(
          (r) =>
            r.array_rulename &&
            r.array_rulename.toLowerCase() === _rrTxt.toLowerCase(),
        )
      : null;
    const rateRule = _rrObj ? _rrObj.array_exchangerateselectionrulesid : "";
    const rateRuleName = _rrObj ? _rrObj.array_rulename : _rrTxt;

    // Document dates win. When the document is silent, default to the lease
    // term (One Time Charge: end = start; Month-to-Month: no end). Defaulted
    // fields are tracked in _defaulted so they re-sync if the lease dates change
    // and are tagged "Defaulted" in the grid for review.
    const _defaulted = {};
    const _leaseStartVal = document.getElementById("startDate")?.value || "";
    const _leaseEndVal = document.getElementById("endDate")?.value || "";
    const _isOneTime = /one\s*time/i.test(frequencyName || _txt("Frequency"));
    let startDate = _toDateInput(_txt("chargeStartDate"));
    let endDate = _toDateInput(_txt("chargeEndDate"));
    if (!startDate && _leaseStartVal) {
      startDate = _leaseStartVal;
      _defaulted.startDate = true;
    }
    if (_isOneTime) {
      if (!endDate && startDate) {
        endDate = startDate;
        if (_defaulted.startDate) _defaulted.endDate = true;
      }
    } else if (!endDate && !_isShortTerm && _leaseEndVal) {
      endDate = _leaseEndVal;
      _defaulted.endDate = true;
    }

    // invoiceGenDate may be a day number (e.g. 3) or a full date string - convert to next future date
    const _invGenRaw = _txt("invoiceGenDate");
    const invoiceGenerationDate = /^\d{1,2}$/.test(_invGenRaw)
      ? (() => {
          const day = parseInt(_invGenRaw);
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          for (let mo = 0; mo <= 3; mo++) {
            const d = new Date(today.getFullYear(), today.getMonth() + mo, day);
            if (!isNaN(d.getTime()) && d.getDate() === day && d >= today)
              return formatDateForInput(d);
          }
          return "";
        })()
      : _toDateInput(_invGenRaw);
    // The agent's chargeAmount is sometimes off by a transcription error. When
    // both the per-m2 rate and billable area are present, derive the amount
    // exactly (rate x area, no rounding) - this is the source of truth and
    // corrects the agent's value. Fall back to the agent amount otherwise.
    const _rate = parseFloat(_txt("ratePerSqM"));
    const _area = parseFloat(_txt("billableArea"));
    const _agentAmount = parseFloat(_txt("chargeAmount")) || 0;
    const amount =
      !isNaN(_rate) && _rate > 0 && !isNaN(_area) && _area > 0
        ? _rate * _area
        : _agentAmount;

    // Resolve invoice type + prefix exactly as the modal does on open
    // (handleChargeTypeChange): property + charge type -> invoice type config ->
    // linked prefix. Without this the autofilled charge is flagged "Incomplete"
    // for these required fields and the user must open each charge just to
    // trigger the lookup.
    let invoiceType = "";
    let invoicePrefix = "";
    let invoicePrefixName = "";
    const _propertyId = document.getElementById("propertyId")?.value || "";
    if (chargeType && _propertyId) {
      const _cfgKey = `${_propertyId}|${chargeType}`;
      if (_invoiceCfgCache[_cfgKey] === undefined) {
        try {
          const _cfgRes = await XrmContext.WebApi.retrieveMultipleRecords(
            "array_propertyinvoicetypeconfiguration",
            `?$select=_array_invoicetype_value&$filter=_array_property_value eq ${_propertyId} and _array_chargetype_value eq ${chargeType}&$top=1`,
          );
          _invoiceCfgCache[_cfgKey] = _cfgRes.entities.length
            ? _cfgRes.entities[0]["_array_invoicetype_value"] || null
            : null;
        } catch (e) {
          console.warn("Autofill: invoice type config lookup failed", e);
          _invoiceCfgCache[_cfgKey] = null;
        }
      }
      const _itId = _invoiceCfgCache[_cfgKey];
      if (_itId) {
        invoiceType = _itId;
        if (_prefixCache[_itId] === undefined) {
          try {
            const _itRec = await XrmContext.WebApi.retrieveRecord(
              "array_invoicetype",
              _itId,
              "?$select=_array_invoiceprefix_value",
            );
            const _prefixId = _itRec._array_invoiceprefix_value;
            if (_prefixId) {
              const _pfxRec = await XrmContext.WebApi.retrieveRecord(
                "array_invoiceprefix",
                _prefixId,
                "?$select=array_invoiceprefixid,array_prefix",
              );
              _prefixCache[_itId] = {
                id: _pfxRec.array_invoiceprefixid,
                name: _pfxRec.array_prefix || "",
              };
            } else {
              _prefixCache[_itId] = null;
            }
          } catch (e) {
            console.warn("Autofill: invoice prefix lookup failed", e);
            _prefixCache[_itId] = null;
          }
        }
        const _pfx = _prefixCache[_itId];
        if (_pfx) {
          invoicePrefix = _pfx.id;
          invoicePrefixName = _pfx.name;
        }
      }
    }

    // Flag the charge "Incomplete" only when a field the modal treats as
    // required is still unresolved after autofill. Mirrors the validation in
    // saveRecurringCharge so the grid tag matches what the modal enforces.
    // Invoice type/prefix are pre-resolved above (they otherwise populate only
    // when the modal is opened), so a fully-extracted charge clears the flag.
    // Exchange rate rule is required only for non-PLN currencies.
    const needsCompletion = _chargeNeedsCompletion({
      name: _txt("chargeName"),
      chargeType,
      amount,
      currency,
      currencyCode,
      isShortTerm: _isShortTerm,
      startDate,
      endDate,
      frequency,
      invoiceGenerationDate,
      dueDateRule,
      vat,
      bankAccount,
      invoiceType,
      invoicePrefix,
      rateRule,
    });

    // Billable area: document value, else the selected units' total area.
    const _docArea = parseFloat(_txt("billableArea"));
    const _unitsArea = parseFloat(
      document.getElementById("totalUnitsArea")?.value || "",
    );
    const _billableArea =
      !isNaN(_docArea) && _docArea > 0
        ? _docArea
        : !isNaN(_unitsArea) && _unitsArea > 0
          ? _unitsArea
          : 0;
    if (!(_docArea > 0) && _billableArea > 0) _defaulted.billableArea = true;

    const charge = {
      id: "temp_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
      name: _txt("chargeName"),
      chargeType,
      chargeTypeName,
      amount,
      currency,
      currencyName,
      currencySymbol,
      currencyCode,
      isShortTerm: _isShortTerm,
      startDate,
      endDate,
      vat,
      vatName,
      frequency,
      frequencyName,
      invoiceGenerationDate,
      dueInDays: parseInt(_txt("dueInDays")) || 0,
      prorationEnabled: false,
      // "płatny z góry" (paid in advance) -> true; extracted by Agent 1
      preFrequencyOffset: _afBool(_txt("preFrequencyOffset")),
      billableArea: _billableArea,
      frequencyStartDate: "",
      frequencyEndDate: "",
      frequencyStartDay: null,
      invoiceGenerationDay: null,
      propertyId: document.getElementById("propertyId")?.value || "",
      prorationEnabledLastCycle: false,
      prorationEnabledFirstCycle: null,
      invoiceSeparately: false,
      bankAccount,
      bankAccountName,
      rateRule,
      rateRuleName,
      dueDateRule,
      taxIncluded: false,
      exchangeRateDay: null,
      invoiceType,
      invoicePrefix,
      invoicePrefixName,
      unitId: null,
      unitName: "",
      tenantId: document.getElementById("tenantId")?.value || "",
      tenantType: document.getElementById("tenantType")?.value || "",
      tenantName: document.getElementById("tenantDisplay")?.value || "",
      isExisting: false,
      useAsInvoiceCurrency: false,
      needsCompletion,
      _defaulted,
    };

    recurringCharges.push(charge);
  }

  // Mark charges as loaded so re-entering Stage 3 just re-renders these instead of
  // reloading/auto-populating from units (which would wipe the autofilled charges).
  chargesLoadedInitially = true;

  renderAllChargesGrid();
  showNotification(
    `${_pcaList.length} charge(s) pre-filled from document. Please open each to complete any missing required fields.`,
    "info",
  );
}

async function _createPartialDepositsFromAutofill() {
  const _psdList = window._pendingSecurityAutofill;
  if (!_psdList || !_psdList.length) return;
  window._pendingSecurityAutofill = null;

  // Ensure option set data is loaded before matching labels
  if (!window.collateralTypes) {
    try {
      window.collateralTypes = await loadCollateralTypes();
    } catch (e) {
      window.collateralTypes = [];
    }
  }

  // Normalize for comparison: collapse whitespace, trim, lowercase.
  const _normLabel = (s) =>
    String(s || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  // Read an option's label, falling back from UserLocalizedLabel to LocalizedLabels
  // (some choices only populate the latter, which previously broke matching).
  const _optionLabel = (r) =>
    r?.Label?.UserLocalizedLabel?.Label ||
    r?.Label?.LocalizedLabels?.[0]?.Label ||
    "";
  const _matchLabel = (arr, val) => {
    const target = _normLabel(val);
    if (!target) return null;
    return (
      (arr || []).find((r) => _normLabel(_optionLabel(r)) === target) || null
    );
  };

  const tenantId = document.getElementById("tenantId")?.value || "";
  const tenantType = document.getElementById("tenantType")?.value || "";
  const tenantName = document.getElementById("tenantDisplay")?.value || "";

  const _depositsBefore = deposits.length;

  for (const _psd of _psdList) {
    const _txt = (k) => (_psd[k] ? String(_psd[k]).trim() : "");

    // Resolve collateralType (securityType label -> option value).
    // If the extracted type is blank or doesn't match a known option, leave it
    // unset (not Deposit) and let needsCompletion flag the record for the user.
    // This form has no deposit sub-type field, so a "Deposit" whose sub-type is
    // "Bank Guarantee" (kaucja ALBO gwarancja bankowa) is mapped to the
    // standalone "Bank Guarantee" type - otherwise both alternatives would show
    // as two identical "Deposit" rows.
    let _secTypeTxt = _txt("securityType");
    if (
      _normLabel(_secTypeTxt) === "deposit" &&
      _normLabel(_txt("depositSubType")) === "bank guarantee"
    ) {
      _secTypeTxt = "Bank Guarantee";
    }
    const _collObj = _matchLabel(window.collateralTypes || [], _secTypeTxt);
    const collateralType = _collObj ? _collObj.Value : "";
    const collateralTypeName = _collObj
      ? _optionLabel(_collObj)
      : _secTypeTxt; // keep raw extracted text so the user sees what was read
    if (_secTypeTxt && !_collObj) {
      console.warn(
        "Security type did not match any collateral option:",
        _secTypeTxt,
        "available:",
        (window.collateralTypes || []).map((r) => _optionLabel(r)),
      );
    }

    // Resolve currency
    const _currTxt = _txt("depositCurrency");
    const _currObj = _currTxt
      ? (window.currencies || []).find(
          (c) =>
            c.isocurrencycode.toLowerCase() === _currTxt.toLowerCase() ||
            c.currencyname.toLowerCase() === _currTxt.toLowerCase(),
        )
      : null;
    const currencyId = _currObj ? _currObj.transactioncurrencyid : "";
    const currencyName = _currObj
      ? `${_currObj.currencyname} (${_currObj.isocurrencycode})`
      : _currTxt;
    const currencySymbol = _currObj?.currencysymbol || "";
    const currencyCode = _currObj?.isocurrencycode || "";

    const amount = parseFloat(_txt("depositRequiredAmount")) || 0;

    // Notary deed (777 p.4/p.5 KPC) securities carry no monetary value, so they
    // are kept even with a blank/zero amount. Every other security type still
    // requires a positive amount - skip zero/blank entries for those.
    const _isNotaryDeed = _normLabel(_txt("securityType")).includes(
      "notary deed",
    );
    if (!_isNotaryDeed && !(amount > 0)) continue;

    const deposit = {
      id: "temp_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
      collateralType,
      collateralTypeName,
      amount,
      payments: 0,
      // Document dates win; otherwise default to the lease start (security is
      // typically delivered by handover). Tracked so it re-syncs with the lease.
      startDate:
        _txt("startDate") ||
        document.getElementById("startDate")?.value ||
        null,
      dueDate:
        _txt("dueDate") || document.getElementById("startDate")?.value || null,
      _defaulted: {
        startDate:
          !_txt("startDate") && !!document.getElementById("startDate")?.value,
        dueDate:
          !_txt("dueDate") && !!document.getElementById("startDate")?.value,
      },
      currencyId,
      currencyName,
      currencySymbol,
      currencyCode,
      tenantId,
      tenantType,
      tenantName,
      unitId: null,
      unitName: "No Unit",
      bankId: null,
      bankName: _txt("Bank"),
      guaranteeNo: _txt("guaranteeNo"),
      requiredAmountCurrencyId: currencyId || null,
      amountDelivered: 0,
      amountDeliveredCurrencyId: null,
      issuerId: null,
      issuerName: "",
      collateralApproved: "",
      isExisting: false,
      needsCompletion: true,
    };

    deposits.push(deposit);
  }

  renderDeposits();
  const _depositsCreated = deposits.length - _depositsBefore;
  if (_depositsCreated > 0) {
    showNotification(
      `${_depositsCreated} security deposit(s) pre-filled from document. Please open each to complete any missing required fields.`,
      "info",
    );
  }

  // Alternative-security detection: when the document gives the tenant a CHOICE
  // of instruments for the SAME obligation (e.g. a cash deposit OR a bank
  // guarantee), the AI returns each option as a separate record - it can't know
  // which the tenant actually used. Such alternatives share the same amount and
  // currency. Flag this so the user keeps only the instrument in force instead
  // of double-counting the security.
  const _newDeposits = deposits.slice(_depositsBefore);
  const _secType = (d) =>
    String(d.collateralTypeName || d.depositTypeName || "")
      .trim()
      .toLowerCase();
  // 1. A cash Deposit and a Bank Guarantee from the same document are always
  //    alternatives ("kaucja lub gwarancja bankowa"), even when the amounts
  //    differ (e.g. the cash deposit carries a +15% FX buffer).
  const _depRecs = _newDeposits.filter(
    (d) => d.amount > 0 && _secType(d) === "deposit",
  );
  const _bgRecs = _newDeposits.filter(
    (d) => d.amount > 0 && _secType(d) === "bank guarantee",
  );
  const _altGroups = [];
  const _grouped = new Set();
  if (_depRecs.length && _bgRecs.length) {
    const g = [..._depRecs, ..._bgRecs];
    g.forEach((d) => _grouped.add(d));
    _altGroups.push(g);
  }
  // 2. Any other records sharing the same amount and currency.
  const _byAmtCcy = {};
  _newDeposits.forEach((d) => {
    if (!(d.amount > 0) || _grouped.has(d)) return;
    const key = `${d.amount}|${(d.currencyCode || d.currencyId || "").toUpperCase()}`;
    (_byAmtCcy[key] = _byAmtCcy[key] || []).push(d);
  });
  Object.values(_byAmtCcy)
    .filter((g) => g.length > 1)
    .forEach((g) => _altGroups.push(g));
  renderSecurityAlternativeNotice(_altGroups);
}

// Inline, closable notice in the Security section warning that the document
// offered alternative security instruments (e.g. cash deposit OR bank
// guarantee) for the same amount - an either/or choice the AI returned in full
// because it can't know which the tenant used. Replaces a transient toast so
// the user has time to act. Pass an empty array to clear it.
function renderSecurityAlternativeNotice(altGroups) {
  const box = document.getElementById("securityAlternativeNotice");
  if (!box) return;
  if (!altGroups || altGroups.length === 0) {
    box.style.display = "none";
    box.innerHTML = "";
    return;
  }

  const _fmtAmt = (d) =>
    `${d.currencySymbol || ""}${Number(d.amount || 0).toFixed(2)} ${escapeHtml(
      d.currencyCode || d.currencyId || "",
    )}`.trim();
  const _typeName = (d) =>
    escapeHtml(d.collateralTypeName || d.depositTypeName || "Security");
  const details = altGroups
    .map((g) => {
      const sameAmt = g.every(
        (d) =>
          d.amount === g[0].amount &&
          (d.currencyCode || d.currencyId) ===
            (g[0].currencyCode || g[0].currencyId),
      );
      if (sameAmt) {
        const options = g.map(_typeName).join(" or ");
        return `<li style="margin:2px 0;">${_fmtAmt(g[0])} - <strong>${options}</strong></li>`;
      }
      // Different amounts: show each instrument with its own amount
      const options = g
        .map((d) => `<strong>${_typeName(d)}</strong> ${_fmtAmt(d)}`)
        .join(" or ");
      return `<li style="margin:2px 0;">${options}</li>`;
    })
    .join("");

  box.innerHTML = `
    <div style="position:relative;border:1px solid var(--amber-mid,#E3B341);background:var(--amber-l,#FEF6E0);border-radius:8px;padding:14px 40px 14px 16px;margin-bottom:20px;">
      <button type="button" onclick="dismissSecurityAlternativeNotice()" title="Dismiss"
        style="position:absolute;top:10px;right:10px;border:none;background:transparent;color:var(--sub);font-size:20px;line-height:1;cursor:pointer;">&times;</button>
      <div style="font-weight:700;color:var(--amber-dk,#8A5A00);font-size:14px;margin-bottom:4px;">Alternative security options detected</div>
      <div style="font-size:13px;color:var(--text);line-height:1.5;">
        The document offers the tenant a choice of security instrument for the same obligation - these are an
        <strong>either/or</strong> choice, so only one applies. Both were pre-filled so you can review; please
        <strong>delete the option(s) that were not used</strong> to avoid double-counting the security.
      </div>
      <ul style="margin:8px 0 0 18px;padding:0;font-size:13px;color:var(--text);">${details}</ul>
    </div>`;
  box.style.display = "";
}

function dismissSecurityAlternativeNotice() {
  const box = document.getElementById("securityAlternativeNotice");
  if (box) {
    box.style.display = "none";
    box.innerHTML = "";
  }
}

//  openRecurringModal FUNCTION // Adding a Recurring Charge

async function openRecurringModal(unitId = null, editCharge = null) {
  const _leaseTermTypeSel = document.getElementById("leaseTermType");
  const _isShortTermLease =
    _leaseTermTypeSel &&
    (
      _leaseTermTypeSel.options[_leaseTermTypeSel.selectedIndex]?.textContent ||
      ""
    )
      .toLowerCase()
      .includes("month-to-month");

  if (units.length === 0 && !_isShortTermLease) {
    showNotification("Please add units in Stage 2 first", "error");
    return;
  }

  window.currentEditCharge = editCharge;

  const modal = document.getElementById("recurringModal");
  if (!modal) {
    console.error(" recurringModal element not found in DOM");
    showNotification(
      "Error loading charge form: Modal element not found. Please refresh the page.",
      "error",
    );
    return;
  }
  modal.classList.add("active");
  document.body.style.overflow = "hidden";

  const modalBody = modal.querySelector(".modal-body");
  if (!modalBody) {
    console.error(" .modal-body not found inside recurringModal");
    showNotification(
      "Error loading charge form: Modal body not found. Please refresh the page.",
      "error",
    );
    modal.classList.remove("active");
    document.body.style.overflow = "";
    return;
  }

  let spinnerOverlay = document.getElementById("recurringModalSpinner");
  if (!spinnerOverlay) {
    spinnerOverlay = document.createElement("div");
    spinnerOverlay.id = "recurringModalSpinner";
    spinnerOverlay.style.cssText = `
      position: absolute; top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(255,255,255,0.92); display: flex; flex-direction: column;
      align-items: center; justify-content: center; z-index: 9999;
      border-radius: inherit; min-height: 400px;
    `;
    spinnerOverlay.innerHTML = `
      <div class="loader" style="width:60px;height:60px;border:5px solid rgba(102,126,234,0.1);border-top:5px solid #667eea;border-radius:50%;animation:spin 0.8s linear infinite;margin-bottom:24px;"></div>
      <p style="color:#667eea;font-size:16px;font-weight:600;margin-bottom:8px;">Loading Charge Form...</p>
      <p style="color:#94a3b8;font-size:13px;">Setting up fields and auto-populating data</p>
    `;
    const mbPos = window.getComputedStyle(modalBody).position;
    if (mbPos === "static") modalBody.style.position = "relative";
    modalBody.appendChild(spinnerOverlay);
  } else {
    spinnerOverlay.style.display = "flex";
  }

  try {
    const [
      chargeTypes,
      currencies,
      frequencies,
      vats,
      invoiceTypes,
      rateRules,
      dueDateRules,
    ] = await Promise.all([
      loadChargeTypes(),
      loadCurrencies(),
      loadFrequencies(),
      loadVATs(),
      loadInvoiceTypes(),
      loadRateRules(),
      loadDueDateRule(),
    ]);

    window.chargeTypes = chargeTypes;
    window.currencies = currencies;
    window.frequencies = frequencies;
    window.vats = vats;
    window.invoiceTypes = invoiceTypes;
    window.rateRules = rateRules;
    window.dueDateRules = dueDateRules;

    if (spinnerOverlay) spinnerOverlay.style.display = "none";

    const previewContainer = document.getElementById(
      "invoiceDatePreviewContainer",
    );
    if (previewContainer && !editCharge) {
      previewContainer.style.display = "none";
      previewContainer.innerHTML = "";
    }

    const chargeTypeSelect = document.getElementById("chargeType");
    if (!chargeTypeSelect) {
      throw new Error(
        "Modal form fields not found. Please refresh and try again.",
      );
    }
    chargeTypeSelect.innerHTML = '<option value="">Select charge type</option>';
    if (window.chargeTypes && window.chargeTypes.length > 0) {
      window.chargeTypes.forEach((type) => {
        const option = document.createElement("option");
        option.value = type.array_chargetypeid;
        option.textContent = type.array_name;
        chargeTypeSelect.appendChild(option);
      });
    }
    chargeTypeSelect.removeEventListener("change", handleChargeTypeChange);
    chargeTypeSelect.addEventListener("change", handleChargeTypeChange);

    const currencySelect = document.getElementById("chargeCurrency");
    currencySelect.innerHTML = '<option value="">Select currency</option>';
    let defaultCurrencyId = null;

    if (window.currencies && window.currencies.length > 0) {
      window.currencies.forEach((currency) => {
        const option = document.createElement("option");
        option.value = currency.transactioncurrencyid;
        option.textContent = `${currency.currencyname} (${currency.isocurrencycode})`;
        currencySelect.appendChild(option);

        const exchangeRate = parseFloat(currency.exchangerate);
        if (exchangeRate === 1.0) {
          defaultCurrencyId = currency.transactioncurrencyid;
        }
      });
    }

    currencySelect.removeEventListener(
      "change",
      handleCurrencyChangeForBankAccount,
    );
    currencySelect.addEventListener(
      "change",
      handleCurrencyChangeForBankAccount,
    );

    const vatSelect = document.getElementById("chargeVat");
    vatSelect.innerHTML = '<option value="">Select VAT</option>';
    if (window.vats && window.vats.length > 0) {
      window.vats.forEach((vat) => {
        const option = document.createElement("option");
        option.value = vat.array_vatid;
        const vatPercentage = vat.array_vat ? ` (${vat.array_vat}%)` : "";
        option.textContent = vat.array_name + vatPercentage;
        vatSelect.appendChild(option);
      });
    }

    const invoiceTypeSelect = document.getElementById("chargeInvoiceType");
    invoiceTypeSelect.innerHTML =
      '<option value="">Select charge type first</option>';

    invoiceTypeSelect.disabled = false;
    invoiceTypeSelect.style.cursor = "";
    invoiceTypeSelect.style.opacity = "";

    invoiceTypeSelect.removeEventListener("change", handleInvoiceTypeChange);
    invoiceTypeSelect.addEventListener("change", handleInvoiceTypeChange);

    const frequencySelect = document.getElementById("chargeFrequency");
    frequencySelect.innerHTML = '<option value="">Select frequency</option>';
    let monthlyValue = null;

    if (window.frequencies && window.frequencies.length > 0) {
      const sortedFrequencies = window.frequencies.sort(
        (a, b) => a.Value - b.Value,
      );
      sortedFrequencies.forEach((freq) => {
        const option = document.createElement("option");
        option.value = freq.Value;
        const label =
          freq.Label && freq.Label.UserLocalizedLabel
            ? freq.Label.UserLocalizedLabel.Label
            : "Unknown";
        option.textContent = label;
        frequencySelect.appendChild(option);

        if (label.toLowerCase() === "monthly") {
          monthlyValue = freq.Value;
        }
      });
    }

    setupInvoiceGenAutoCalculation();

    const dueDateRuleSelect = document.getElementById("chargeDueDateRule");
    dueDateRuleSelect.innerHTML =
      '<option value="">Select due date rule</option>';
    if (window.dueDateRules && window.dueDateRules.length > 0) {
      const sortedDueDateRules = window.dueDateRules.sort(
        (a, b) => a.Value - b.Value,
      );
      sortedDueDateRules.forEach((rule) => {
        const option = document.createElement("option");
        option.value = rule.Value;
        const label =
          rule.Label && rule.Label.UserLocalizedLabel
            ? rule.Label.UserLocalizedLabel.Label
            : "Unknown";
        option.textContent = label;
        dueDateRuleSelect.appendChild(option);
      });
    }
    dueDateRuleSelect.removeEventListener("change", handleDueDateRuleChange);
    dueDateRuleSelect.addEventListener("change", handleDueDateRuleChange);

    const unitSelect = document.getElementById("chargeUnitSelect");
    unitSelect.innerHTML = '<option value="">Select Unit (Optional)</option>';
    units.forEach((unit) => {
      const option = document.createElement("option");
      option.value = unit.id;
      option.textContent = unit.name;
      unitSelect.appendChild(option);
    });

    unitSelect.removeEventListener(
      "change",
      handleUnitSelectionForBillableArea,
    );
    unitSelect.addEventListener("change", handleUnitSelectionForBillableArea);

    // Single-unit lease: pre-select the only unit (the dropdown otherwise defaults to
    // "Select Unit (Optional)"). Edit mode sets its own unit below, so skip there.
    if (!editCharge && units.length === 1) {
      unitSelect.value = units[0].id;
      if (typeof handleUnitSelectionForBillableArea === "function")
        handleUnitSelectionForBillableArea();
    }

    const bankAccountDisplay = document.getElementById(
      "chargeBankAccountDisplay",
    );
    if (bankAccountDisplay) {
      const newBankAccountDisplay = bankAccountDisplay.cloneNode(true);
      bankAccountDisplay.parentNode.replaceChild(
        newBankAccountDisplay,
        bankAccountDisplay,
      );

      newBankAccountDisplay.addEventListener("click", function (e) {
        if (!this.disabled) {
          e.preventDefault();
          e.stopPropagation();
          openBankAccountLookup();
        }
      });

      newBankAccountDisplay.style.cursor = "pointer";
      newBankAccountDisplay.style.pointerEvents = "auto";
    }

    const leaseTermTypeSelect = document.getElementById("leaseTermType");
    const selectedOption =
      leaseTermTypeSelect.options[leaseTermTypeSelect.selectedIndex];
    const isShortTerm =
      selectedOption &&
      selectedOption.textContent.toLowerCase().includes("month-to-month");

    const endDateField = document.getElementById("chargeEndDate");
    const endDateGroup = endDateField.closest(".form-group");

    if (editCharge) {
      // ===== EDIT MODE =====
      document.getElementById("recurringModalTitle").textContent =
        "Edit Recurring Charge";
      document.getElementById("btnSaveChargeText").textContent =
        "Update Charge";
      document.getElementById("chargeEditId").value = editCharge.id;
      document.getElementById("chargeUnitSelect").value =
        editCharge.unitId || "";
      document.getElementById("chargeName").value = editCharge.name;
      document.getElementById("chargeType").value = editCharge.chargeType;
      document.getElementById("chargeAmount").value = editCharge.amount;

      // Setting chargeType.value in code does NOT fire a 'change' event, so the
      // invoice-type + prefix auto-derivation (keyed off charge type + property)
      // never runs for autofilled/edited charges - those fields stayed blank
      // until the user manually re-picked the charge type. Trigger it explicitly.
      if (editCharge.chargeType) {
        await handleChargeTypeChange();
      }

      if (editCharge.isExisting && editCharge.needsAutoPopulate) {
        // ===== AUTO-POPULATE FOR UNIT RECURRING CHARGES (isExisting) =====
        const leaseStartDate =
          document.getElementById("startDate")?.value || "";
        const leaseEndDate = document.getElementById("endDate")?.value || "";
        const todayStr = formatDateForInput(new Date());
        const billableAreaValue = editCharge.unitArea
          ? editCharge.unitArea
          : totalUnitsAreaValue > 0
            ? totalUnitsAreaValue.toFixed(2)
            : "";

        const startDateField = document.getElementById("chargeStartDate");
        startDateField.value = leaseStartDate;
        if (leaseStartDate)
          startDateField.setAttribute("data-user-input", "true");

        endDateGroup.style.display = "";
        endDateField.value = leaseEndDate;
        if (isShortTerm) {
          endDateField.removeAttribute("required");
        } else {
          endDateField.setAttribute("required", "required");
        }
        if (leaseEndDate) {
          endDateField.setAttribute("data-user-input", "true");
          endDateField.setAttribute("max", leaseEndDate);
        } else {
          endDateField.removeAttribute("max");
        }

        const _invGenFieldAutoPopulate = document.getElementById(
          "chargeInvoiceGenerationDate",
        );
        _invGenFieldAutoPopulate.value = todayStr;
        _invGenFieldAutoPopulate.setAttribute("min", todayStr);

        if (editCharge.currency) {
          document.getElementById("chargeCurrency").value = editCharge.currency;
          if (editCharge.currency && window.currencies) {
            const editCurrObj = window.currencies.find(
              (c) => c.transactioncurrencyid === editCharge.currency,
            );
            const editCurrCode = editCurrObj
              ? (editCurrObj.isocurrencycode || "").toUpperCase()
              : "";
            toggleRateRuleVisibility(editCurrCode !== "PLN");
          } else {
            toggleRateRuleVisibility(true);
          }
          currencySelect.setAttribute("data-user-input", "true");
          unlockBankAccountField();
          await autoPopulateBankAccountByCurrency(editCharge.currency);
        } else if (defaultCurrencyId) {
          document.getElementById("chargeCurrency").value = defaultCurrencyId;
          currencySelect.setAttribute("data-user-input", "true");
          unlockBankAccountField();
          await autoPopulateBankAccountByCurrency(defaultCurrencyId);
        }

        document.getElementById("chargeFrequency").value =
          editCharge.frequency !== ""
            ? editCharge.frequency
            : monthlyValue || "";

        const billableAreaField = document.getElementById("chargeBillableArea");
        if (billableAreaValue) {
          billableAreaField.value = billableAreaValue;
          billableAreaField.setAttribute("data-user-input", "true");
        }

        autoPopulateDueDateRule();
        autoPopulateRateRule();

        document.getElementById("chargeVat").value = "";
        document.getElementById("chargeDueInDays").value = "";
        document.getElementById("chargeProrationEnabled").value = "false";
        document.getElementById("chargePreFrequencyOffset").value = "false";
        document.getElementById("chargeInvoiceSeparately").value = "false";
        document.getElementById("prorationConditionalFields").style.display =
          "none";
        document.getElementById("chargeFrequencyStartDate").value = "";
        document.getElementById("chargeProrationEnabledLastCycle").value =
          "false";
        document.getElementById("chargeProrationEnabledFirstCycle").value =
          "false";
        document.getElementById(
          "firstCycleFrequencyEndDateGroup",
        ).style.display = "none";
        document.getElementById("chargeTaxIncluded").value = "false";
      } else {
        // ===== STANDARD EDIT (manually added charge or already-populated existing) =====

        document.getElementById("chargeCurrency").value = editCharge.currency;

        //  FIX: Determine PLN status once and use for both invoice currency group AND rate rule visibility
        const _editCurrObj = window.currencies
          ? window.currencies.find(
              (c) => c.transactioncurrencyid === editCharge.currency,
            )
          : null;
        const _editIsPLN =
          _editCurrObj &&
          (_editCurrObj.isocurrencycode || "").toUpperCase() === "PLN";

        // Restore "Use as Invoice Currency" field visibility + value
        const _editInvCurrGroup = document.getElementById(
          "useAsInvoiceCurrencyGroup",
        );
        if (_editInvCurrGroup) {
          _editInvCurrGroup.style.display = _editIsPLN ? "none" : "";
          const _editSel = document.getElementById(
            "chargeUseAsInvoiceCurrency",
          );
          if (_editSel)
            _editSel.value =
              !_editIsPLN && editCharge.useAsInvoiceCurrency ? "true" : "false";
        }

        //  FIX: Always sync rate rule visibility with the charge's actual currency
        // This prevents the rate rule field from showing when currency is PLN (default),
        // which happened because toggleRateRuleVisibility was never called in edit mode.
        toggleRateRuleVisibility(!_editIsPLN);

        document.getElementById("chargeProrationEnabled").value =
          editCharge.prorationEnabled ? "true" : "false";
        document.getElementById("chargePreFrequencyOffset").value =
          editCharge.preFrequencyOffset ? "true" : "false";

        const startDateField = document.getElementById("chargeStartDate");
        startDateField.value = editCharge.startDate;
        if (editCharge.startDate) {
          startDateField.setAttribute("data-user-input", "true");
        }

        const _leaseEnd = document.getElementById("endDate")?.value || "";
        endDateGroup.style.display = "";
        endDateField.value =
          editCharge.endDate || (isShortTerm ? _leaseEnd : "");
        if (isShortTerm) {
          endDateField.removeAttribute("required");
        } else {
          endDateField.setAttribute("required", "required");
        }
        if (endDateField.value) {
          endDateField.setAttribute("data-user-input", "true");
        }
        if (_leaseEnd) {
          endDateField.setAttribute("max", _leaseEnd);
        } else {
          endDateField.removeAttribute("max");
        }

        document.getElementById("chargeVat").value = editCharge.vat || "";
        document.getElementById("chargeFrequency").value =
          editCharge.frequency !== "" ? editCharge.frequency : "";

        const _invGenFieldEdit = document.getElementById(
          "chargeInvoiceGenerationDate",
        );
        _invGenFieldEdit.value = editCharge.invoiceGenerationDate || "";
        _invGenFieldEdit.setAttribute("min", formatDateForInput(new Date()));
        document.getElementById("chargeDueInDays").value =
          editCharge.dueInDays || "";

        if (editCharge.billableArea) {
          document.getElementById("chargeBillableArea").value =
            editCharge.billableArea;
        }

        if (editCharge.invoiceSeparately !== undefined) {
          document.getElementById("chargeInvoiceSeparately").value =
            editCharge.invoiceSeparately ? "true" : "false";
        }

        if (editCharge.bankAccount) {
          document.getElementById("chargeBankAccount").value =
            editCharge.bankAccount;
          document.getElementById("chargeBankAccountDisplay").value =
            editCharge.bankAccountName || "";

          const clearBankAccountBtn = document.getElementById(
            "clearBankAccountBtn",
          );
          if (clearBankAccountBtn) {
            clearBankAccountBtn.style.display = "block";
          }
        }

        //  FIX: Only restore rate rule fields when currency is NOT PLN.
        // Previously, rate rule was always set regardless of currency, causing
        // the Exchange Rate Rule field to appear even when currency = PLN (default).
        if (editCharge.rateRule && !_editIsPLN) {
          document.getElementById("chargeRateRule").value = editCharge.rateRule;
          document.getElementById("chargeRateRuleDisplay").value =
            editCharge.rateRuleName || "";

          const clearRateRuleBtn = document.getElementById("clearRateRuleBtn");
          if (clearRateRuleBtn) {
            clearRateRuleBtn.style.display = "block";
          }

          toggleExchangeRateDayField(editCharge.rateRuleName || "");
          if (
            editCharge.exchangeRateDay !== null &&
            editCharge.exchangeRateDay !== undefined
          ) {
            document.getElementById("chargeExchangeRateDay").value =
              editCharge.exchangeRateDay;
          }
        } else if (_editIsPLN) {
          //  FIX: If currency is PLN, ensure rate rule fields are cleared
          // (handles the case where user previously changed to non-PLN and saved)
          document.getElementById("chargeRateRule").value = "";
          document.getElementById("chargeRateRuleDisplay").value = "";
          document.getElementById("chargeExchangeRateDay").value = "";
          const clearRateRuleBtn = document.getElementById("clearRateRuleBtn");
          if (clearRateRuleBtn) clearRateRuleBtn.style.display = "none";
          const exchangeRateDayGroup = document.getElementById(
            "exchangeRateDayGroup",
          );
          if (exchangeRateDayGroup) exchangeRateDayGroup.style.display = "none";
        }

        if (
          editCharge.dueDateRule !== undefined &&
          editCharge.dueDateRule !== ""
        ) {
          document.getElementById("chargeDueDateRule").value =
            editCharge.dueDateRule;
        }

        document.getElementById("chargeTaxIncluded").value =
          editCharge.taxIncluded ? "true" : "false";

        if (editCharge.invoiceType) {
          document.getElementById("chargeInvoiceType").value =
            editCharge.invoiceType;
          invoiceTypeSelect.disabled = false;
          invoiceTypeSelect.style.cursor = "";
          invoiceTypeSelect.style.opacity = "1";
        }

        if (editCharge.invoicePrefix) {
          document.getElementById("chargeInvoicePrefix").value =
            editCharge.invoicePrefix;
          document.getElementById("chargeInvoicePrefixDisplay").value =
            editCharge.invoicePrefixName || "";
        }

        if (editCharge.prorationEnabled) {
          document.getElementById("prorationConditionalFields").style.display =
            "block";

          if (editCharge.prorationEnabledFirstCycle !== undefined) {
            const firstCycleField = document.getElementById(
              "chargeProrationEnabledFirstCycle",
            );
            firstCycleField.value = editCharge.prorationEnabledFirstCycle
              ? "true"
              : "false";
            firstCycleField.setAttribute("data-user-input", "true");
          }

          const firstCycleEnabled =
            document.getElementById("chargeProrationEnabledFirstCycle")
              .value === "true";
          const endDateGroup = document.getElementById(
            "firstCycleFrequencyEndDateGroup",
          );
          if (firstCycleEnabled) {
            endDateGroup.style.display = "block";
            if (editCharge.frequencyStartDate) {
              const freqStartField = document.getElementById(
                "chargeFrequencyStartDate",
              );
              freqStartField.value = editCharge.frequencyStartDate;
              freqStartField.setAttribute("data-user-input", "true");
            }
          } else {
            endDateGroup.style.display = "none";
            if (editCharge.frequencyStartDate) {
              const freqStartField = document.getElementById(
                "chargeFrequencyStartDate",
              );
              freqStartField.value = editCharge.frequencyStartDate;
            }
          }

          if (editCharge.prorationEnabledLastCycle !== undefined) {
            const prorationLastCycleField = document.getElementById(
              "chargeProrationEnabledLastCycle",
            );
            prorationLastCycleField.value = editCharge.prorationEnabledLastCycle
              ? "true"
              : "false";
            prorationLastCycleField.setAttribute("data-user-input", "true");
          }
        } else {
          document.getElementById("prorationConditionalFields").style.display =
            "none";
          document.getElementById("chargeFrequencyStartDate").value = "";
          document.getElementById("chargeProrationEnabledLastCycle").value =
            "false";
          document.getElementById("chargeProrationEnabledFirstCycle").value =
            "false";
          document.getElementById(
            "firstCycleFrequencyEndDateGroup",
          ).style.display = "none";
        }

        // Unlock bank account for edit mode if currency is selected
        const newBankAccountDisplay2 = document.getElementById(
          "chargeBankAccountDisplay",
        );
        if (editCharge.currency) {
          newBankAccountDisplay2.disabled = false;
          newBankAccountDisplay2.style.cursor = "pointer";
          newBankAccountDisplay2.style.opacity = "1";
          newBankAccountDisplay2.style.pointerEvents = "auto";
        } else {
          lockBankAccountField();
        }

        handleProrationChange();

        setTimeout(() => {
          const filledInputs = modal.querySelectorAll(
            'input[value]:not([value=""]), select',
          );
          filledInputs.forEach((input) => {
            if (input.value && input.value !== "") {
              input.setAttribute("data-user-input", "true");
              updateFieldState(input);
            }
          });

          updateInvoiceDatePreview();
        }, 100);
      }
    } else {
      // ===== NEW CHARGE MODE =====
      document.getElementById("recurringModalTitle").textContent =
        "Add Recurring Charge";
      document.getElementById("btnSaveChargeText").textContent = "Add Charge";
      document.getElementById("chargeEditId").value = "";
      document.getElementById("chargeUnitSelect").value = unitId || "";
      document.getElementById("chargeName").value = "";
      document.getElementById("chargeType").value = "";
      document.getElementById("chargeAmount").value = "";

      const _newInvCurrGroup = document.getElementById(
        "useAsInvoiceCurrencyGroup",
      );
      if (_newInvCurrGroup) _newInvCurrGroup.style.display = "none";
      const _newInvCurrSel = document.getElementById(
        "chargeUseAsInvoiceCurrency",
      );
      if (_newInvCurrSel) _newInvCurrSel.value = "false";

      document.getElementById("chargeProrationEnabled").value = "false";
      document.getElementById("chargePreFrequencyOffset").value = "false";

      const leaseStartDateValue =
        document.getElementById("startDate")?.value || "";
      const leaseEndDateValue = document.getElementById("endDate")?.value || "";

      const startDateField = document.getElementById("chargeStartDate");
      if (leaseStartDateValue) {
        startDateField.value = leaseStartDateValue;
        startDateField.setAttribute("data-user-input", "true");
        startDateField.setAttribute("data-user-modified", "true");
      } else {
        startDateField.value = "";
        startDateField.removeAttribute("data-user-input");
        startDateField.removeAttribute("data-user-modified");
      }

      endDateGroup.style.display = "";
      if (isShortTerm) {
        endDateField.value = leaseEndDateValue;
        endDateField.removeAttribute("required");
        if (leaseEndDateValue) {
          endDateField.setAttribute("data-user-input", "true");
        }
      } else {
        endDateField.value = "";
        endDateField.removeAttribute("data-user-input");
        endDateField.removeAttribute("data-user-modified");
        endDateField.setAttribute("required", "required");
      }
      if (leaseEndDateValue) {
        endDateField.setAttribute("max", leaseEndDateValue);
      } else {
        endDateField.removeAttribute("max");
      }

      document.getElementById("chargeVat").value = "";
      const _invGenField = document.getElementById(
        "chargeInvoiceGenerationDate",
      );
      _invGenField.value = "";
      _invGenField.setAttribute("min", formatDateForInput(new Date()));
      document.getElementById("chargeDueInDays").value = "";

      const previewContainer = document.getElementById(
        "invoiceDatePreviewContainer",
      );
      if (previewContainer) {
        previewContainer.style.display = "none";
      }

      const billableAreaField = document.getElementById("chargeBillableArea");
      if (unitId) {
        const selectedUnit = units.find((u) => u.id === unitId);
        if (selectedUnit && selectedUnit.area) {
          billableAreaField.value = selectedUnit.area;
          billableAreaField.setAttribute("data-user-input", "true");
        }
      } else {
        const manualTotalArea =
          parseFloat(document.getElementById("totalUnitsArea")?.value) ||
          totalUnitsAreaValue;
        if (manualTotalArea > 0) {
          billableAreaField.value = manualTotalArea.toFixed(2);
          billableAreaField.setAttribute("data-user-input", "true");
        }
      }

      document.getElementById("chargeInvoiceSeparately").value = "false";

      document.getElementById("chargeBankAccount").value = "";
      document.getElementById("chargeBankAccountDisplay").value = "";

      const clearBankAccountBtn = document.getElementById(
        "clearBankAccountBtn",
      );
      if (clearBankAccountBtn) {
        clearBankAccountBtn.style.display = "none";
      }

      lockBankAccountField();

      document.getElementById("chargeRateRule").value = "";
      document.getElementById("chargeRateRuleDisplay").value = "";

      const clearRateRuleBtn = document.getElementById("clearRateRuleBtn");
      if (clearRateRuleBtn) {
        clearRateRuleBtn.style.display = "none";
      }

      autoPopulateRateRule();

      document.getElementById("chargeInvoiceType").value = "";
      document.getElementById("chargeInvoicePrefix").value = "";
      document.getElementById("chargeInvoicePrefixDisplay").value = "";

      document.getElementById("prorationConditionalFields").style.display =
        "none";
      document.getElementById("chargeFrequencyStartDate").value = "";
      document.getElementById("chargeProrationEnabledLastCycle").value =
        "false";
      document.getElementById("chargeProrationEnabledFirstCycle").value =
        "false";
      document.getElementById("firstCycleFrequencyEndDateGroup").style.display =
        "none";

      if (defaultCurrencyId) {
        currencySelect.value = defaultCurrencyId;
        currencySelect.setAttribute("data-user-input", "true");

        const defCurrObj = window.currencies
          ? window.currencies.find(
              (c) => c.transactioncurrencyid === defaultCurrencyId,
            )
          : null;
        const defCurrCode = defCurrObj
          ? (defCurrObj.isocurrencycode || "").toUpperCase()
          : "";
        const defIsPLN = defCurrCode === "PLN";
        toggleRateRuleVisibility(!defIsPLN);

        await autoPopulateBankAccountByCurrency(defaultCurrencyId);
      } else {
        currencySelect.value = "";
        toggleRateRuleVisibility(true);
      }

      if (monthlyValue) {
        frequencySelect.value = monthlyValue;
        frequencySelect.setAttribute("data-user-input", "true");
      }

      handleProrationChange();

      setTimeout(() => {
        // Skip the focused control so we don't collapse an open native dropdown
        // the user just clicked (see the 100ms loop below for the full rationale).
        const _upd = (el) => {
          if (el && el !== document.activeElement) updateFieldState(el);
        };
        if (currencySelect.value) {
          _upd(currencySelect);
        }
        if (frequencySelect.value) {
          _upd(frequencySelect);
        }
        if (unitSelect.value) {
          _upd(unitSelect);
        }
        if (billableAreaField.value) {
          _upd(billableAreaField);
        }

        _upd(document.getElementById("chargeBankAccountDisplay"));
        _upd(document.getElementById("chargeRateRuleDisplay"));
      }, 50);
    }

    setTimeout(() => {
      const modalInputs = modal.querySelectorAll(
        'input:not([type="hidden"]), select, textarea',
      );
      modalInputs.forEach((input) => {
        // Skip the control the user is actively interacting with. updateFieldState
        // toggles the element's class list, and mutating an open native <select>
        // collapses its dropdown - repro: open the modal and immediately click the
        // Charge Type dropdown, it snapped shut. Its own change/blur updates it later.
        if (input === document.activeElement) return;
        updateFieldState(input);
      });
    }, 100);

    setTimeout(() => {
      const fieldsToWatch = [
        "chargeType",
        "chargeStartDate",
        "chargeEndDate",
        "chargeAmount",
        "chargeFrequency",
        "chargeInvoiceGenerationDate",
        "chargeDueInDays",
        "chargeProrationEnabled",
        "chargePreFrequencyOffset",
        "chargeFrequencyStartDate",
        "chargeCurrency",
        "chargeVat",
      ];

      fieldsToWatch.forEach((fieldId) => {
        const field = document.getElementById(fieldId);
        if (field) {
          field.removeEventListener("change", handleFieldChangeForPreview);
          field.removeEventListener("input", handleFieldChangeForPreview);

          field.addEventListener("change", handleFieldChangeForPreview);
          if (field.tagName === "INPUT" && field.type !== "hidden") {
            field.addEventListener("input", handleFieldChangeForPreview);
          }
        }
      });
    }, 150);
  } catch (error) {
    console.error(" Error loading charge modal:", error);

    const spinnerEl = document.getElementById("recurringModalSpinner");
    if (spinnerEl) spinnerEl.style.display = "none";

    showNotification("Error loading charge form: " + error.message, "error");
    closeModal("recurringModal");
  }
}

// Save the Charge
//  Helper: extract day-of-month (whole number) from a YYYY-MM-DD date string
function extractDayFromDate(dateStr) {
  if (!dateStr || dateStr.trim() === "") return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return d.getDate(); // returns 1-31
}

//  Helper: compute frequencyEndDate from frequencyStartDate based on frequency
// Rules:
//   Monthly    -> start + 1 month  - 1 day
//   Weekly     -> start + 7 days   - 1 day
//   Yearly     -> start + 365 days - 1 day
//   Quarterly  -> start + 3 months - 1 day
//   Daily      -> start + 1 day    - 1 day  = same day
// When prorationEnabled AND prorationEnabledFirstCycle are both true,
// the First Cycle Frequency End Date (chargeFrequencyStartDate field value) is used instead.
function computeFrequencyEndDate(
  frequencyStartDate,
  frequencyValue,
  prorationEnabled,
  prorationEnabledFirstCycle,
  firstCycleEndDateFieldValue,
) {
  // If first cycle proration is active, use that date directly
  if (
    (prorationEnabled === true || prorationEnabled === "true") &&
    (prorationEnabledFirstCycle === true ||
      prorationEnabledFirstCycle === "true") &&
    firstCycleEndDateFieldValue &&
    firstCycleEndDateFieldValue.trim() !== ""
  ) {
    return firstCycleEndDateFieldValue; // already in YYYY-MM-DD
  }

  if (!frequencyStartDate || frequencyStartDate.trim() === "") return null;

  // Parse YYYY-MM-DD as a local date (new Date("YYYY-MM-DD") is UTC midnight,
  // which lands on the previous day west of UTC)
  const _parts = frequencyStartDate.split("T")[0].split("-").map(Number);
  const start =
    _parts.length === 3
      ? new Date(_parts[0], _parts[1] - 1, _parts[2])
      : new Date(frequencyStartDate);
  if (isNaN(start.getTime())) return null;

  const freqInt = parseInt(frequencyValue);
  let end = new Date(start);

  // Start of the next cycle, n months on. If that month has no such day
  // (31 Jan + 1 month), the next cycle starts on the 1st of the month after, so the
  // cycle ends on the last day of the month (31 Jan -> 28/29 Feb, not 2 Mar).
  const _addMonths = (d, n) => {
    const day = d.getDate();
    const r = new Date(d.getFullYear(), d.getMonth() + n, 1);
    const lastDay = new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate();
    if (day > lastDay) r.setMonth(r.getMonth() + 1);
    else r.setDate(day);
    return r;
  };

  // Frequency option-set values (from existing code mappings):
  // 126330000 = Monthly, 126330004 = Weekly, 126330001 = Yearly,
  // 126330005 = Quarterly, 126330003 = Daily
  if (freqInt === 126330000) {
    // Monthly: +1 month -1 day
    end = _addMonths(start, 1);
    end.setDate(end.getDate() - 1);
  } else if (freqInt === 126330004) {
    // Weekly: +7 days -1 day = +6 days
    end.setDate(end.getDate() + 6);
  } else if (freqInt === 126330001) {
    // Yearly: +365 days -1 day = +364 days
    end.setDate(end.getDate() + 364);
  } else if (freqInt === 126330005) {
    // Quarterly: +3 months -1 day
    end = _addMonths(start, 3);
    end.setDate(end.getDate() - 1);
  } else if (freqInt === 126330003) {
    // Daily: +1 day -1 day = same day
    // end stays the same as start
  } else {
    return null; // unknown frequency
  }

  // Return as YYYY-MM-DD
  const year = end.getFullYear();
  const month = String(end.getMonth() + 1).padStart(2, "0");
  const day = String(end.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function saveRecurringCharge() {
  console.log(" saveRecurringCharge function called");

  const editId = document.getElementById("chargeEditId").value;
  const unitId = document.getElementById("chargeUnitSelect").value;
  const chargeName = document.getElementById("chargeName").value.trim();
  const chargeType = document.getElementById("chargeType").value;
  const chargeAmount = parseFloat(
    document.getElementById("chargeAmount").value,
  );
  const chargeCurrency = document.getElementById("chargeCurrency").value;
  const startDate = document.getElementById("chargeStartDate").value;

  const leaseTermTypeSelect = document.getElementById("leaseTermType");
  const selectedOption =
    leaseTermTypeSelect.options[leaseTermTypeSelect.selectedIndex];
  const isShortTerm =
    selectedOption &&
    selectedOption.textContent.toLowerCase().includes("month-to-month");

  const frequency = document.getElementById("chargeFrequency").value;
  const _rawFreqStartDate =
    document.getElementById("chargeFrequencyStartDate").value || "";
  const _rawProrationEnabled =
    document.getElementById("chargeProrationEnabled").value === "true";
  const _rawProrationFirstCycleRaw = document.getElementById(
    "chargeProrationEnabledFirstCycle",
  ).value;
  const _rawProrationFirstCycle =
    _rawProrationFirstCycleRaw === "true"
      ? true
      : _rawProrationFirstCycleRaw === "false"
        ? false
        : null;
  const _rawFirstCycleEndDate =
    document.getElementById("chargeFrequencyStartDate").value || "";
  const _chargeEndDateFieldValue =
    document.getElementById("chargeEndDate").value || "";
  // End Date = the date in the form. Only when it is empty on a Month-to-Month
  // lease, fall back to the end of the first cycle counted from the Start Date.
  const endDate = _chargeEndDateFieldValue
    ? _chargeEndDateFieldValue
    : isShortTerm
      ? computeFrequencyEndDate(
          startDate,
          frequency,
          _rawProrationEnabled,
          _rawProrationFirstCycle,
          _rawFirstCycleEndDate,
        ) || ""
      : "";

  const vatValue = document.getElementById("chargeVat").value;
  const invoiceGenerationDate = document.getElementById(
    "chargeInvoiceGenerationDate",
  ).value;
  const dueInDays =
    parseInt(document.getElementById("chargeDueInDays").value) || 0;
  const prorationEnabled =
    document.getElementById("chargeProrationEnabled").value === "true";
  const preFrequencyOffset =
    document.getElementById("chargePreFrequencyOffset").value === "true";
  const billableArea =
    parseFloat(document.getElementById("chargeBillableArea").value) || 0;
  const frequencyStartDate =
    document.getElementById("chargeFrequencyStartDate").value || "";
  const prorationEnabledLastCycle =
    document.getElementById("chargeProrationEnabledLastCycle").value === "true";
  const prorationEnabledFirstCycleRaw = document.getElementById(
    "chargeProrationEnabledFirstCycle",
  ).value;
  const prorationEnabledFirstCycle =
    prorationEnabledFirstCycleRaw === "true"
      ? true
      : prorationEnabledFirstCycleRaw === "false"
        ? false
        : null;
  const invoiceSeparately =
    document.getElementById("chargeInvoiceSeparately").value === "true";
  const bankAccount = document.getElementById("chargeBankAccount").value || "";
  const bankAccountName =
    document.getElementById("chargeBankAccountDisplay").value || "";
  const rateRule = document.getElementById("chargeRateRule").value || "";
  const rateRuleName =
    document.getElementById("chargeRateRuleDisplay").value || "";
  const dueDateRule = document.getElementById("chargeDueDateRule").value || "";
  const taxIncluded =
    document.getElementById("chargeTaxIncluded").value === "true";
  const exchangeRateDayRaw = document.getElementById(
    "chargeExchangeRateDay",
  ).value;
  const exchangeRateDay =
    exchangeRateDayRaw !== "" ? parseInt(exchangeRateDayRaw) : null;

  const invoiceType = document.getElementById("chargeInvoiceType")?.value || "";
  const invoicePrefix =
    document.getElementById("chargeInvoicePrefix")?.value || "";
  const invoicePrefixName =
    document.getElementById("chargeInvoicePrefixDisplay")?.value || "";

  const invoiceCurrencyGroup = document.getElementById(
    "useAsInvoiceCurrencyGroup",
  );
  const useAsInvoiceCurrency =
    invoiceCurrencyGroup && invoiceCurrencyGroup.style.display !== "none"
      ? document.getElementById("chargeUseAsInvoiceCurrency")?.value === "true"
      : false;

  const tenantId = document.getElementById("tenantId").value;
  const tenantType = document.getElementById("tenantType").value;
  const tenantName = document.getElementById("tenantDisplay").value;

  // -- Validation --------------------------------------------------------------
  if (!chargeName)
    return showNotification(" Please enter a charge name", "error");
  if (!chargeType)
    return showNotification(" Please select a charge type", "error");
  if (!chargeAmount || chargeAmount <= 0)
    return showNotification(" Please enter a valid amount", "error");
  if (!chargeCurrency)
    return showNotification(" Please select a currency", "error");
  if (!startDate)
    return showNotification(" Please select a start date", "error");
  if (!isShortTerm && !endDate)
    return showNotification(" Please select an end date", "error");
  // Hard guard: End Date must be after Start Date (unconditional - covers every
  // frequency and both manual + autofilled charges, so it can't be bypassed).
  if (!isShortTerm && endDate && startDate) {
    const _sd = new Date(startDate);
    _sd.setHours(0, 0, 0, 0);
    const _ed = new Date(endDate);
    _ed.setHours(0, 0, 0, 0);
    if (_ed <= _sd) {
      return showNotification(
        " End Date must be after the Start Date",
        "error",
      );
    }
  }
  // Cap: charge end date must not exceed lease end date (from Step 2). Applies to both term types.
  const _leaseEndForCap = document.getElementById("endDate")?.value || "";
  if (endDate && _leaseEndForCap) {
    const _ce = new Date(endDate);
    _ce.setHours(0, 0, 0, 0);
    const _le = new Date(_leaseEndForCap);
    _le.setHours(0, 0, 0, 0);
    if (_ce > _le) {
      return showNotification(
        " Charge End Date cannot exceed the Lease End Date",
        "error",
      );
    }
  }
  if (!frequency)
    return showNotification(" Please select a frequency", "error");
  if (!invoiceGenerationDate)
    return showNotification(
      " Please select an invoice generation date",
      "error",
    );

  const _today = new Date();
  _today.setHours(0, 0, 0, 0);
  const _invGenParsed = new Date(invoiceGenerationDate);
  _invGenParsed.setHours(0, 0, 0, 0);
  if (_invGenParsed < _today) {
    return showNotification(
      " Invoice Generation Date cannot be in the past.",
      "error",
    );
  }

  if (dueInDays === null || dueInDays === undefined)
    return showNotification(" Please enter due in days", "error");
  if (!dueDateRule)
    return showNotification(" Please select a due date rule", "error");
  if (!vatValue) return showNotification(" Please select a VAT", "error");
  if (!bankAccount)
    return showNotification(" Please select a bank account", "error");
  if (!invoiceType)
    return showNotification(" Please select an invoice type", "error");
  if (!invoicePrefix)
    return showNotification(" Please select an invoice prefix", "error");

  // Exchange Rate Rule is mandatory whenever its field is shown (non-PLN
  // currencies). The field is hidden+cleared for PLN, so guard on visibility.
  const rateRuleDisplayEl = document.getElementById("chargeRateRuleDisplay");
  const rateRuleGroup = rateRuleDisplayEl
    ? rateRuleDisplayEl.closest(".form-group")
    : null;
  const isRateRuleVisible =
    rateRuleGroup && rateRuleGroup.style.display !== "none";
  if (isRateRuleVisible && !rateRule) {
    return showNotification(" Please select an exchange rate rule", "error");
  }

  //  FIXED: Only validate Exchange Rate Day when the field is actually visible
  const exchangeRateDayGroup = document.getElementById("exchangeRateDayGroup");
  const isExchangeRateDayVisible =
    exchangeRateDayGroup && exchangeRateDayGroup.style.display !== "none";
  if (isExchangeRateDayVisible) {
    if (
      exchangeRateDay === null ||
      isNaN(exchangeRateDay) ||
      !Number.isInteger(exchangeRateDay) ||
      exchangeRateDay < 1
    ) {
      return showNotification(
        " Please enter a valid whole number for Exchange Rate Day",
        "error",
      );
    }
  }

  // Validate Unit
  const cleanUnitId =
    unitId &&
    unitId.trim() !== "" &&
    unitId !== "Select Unit (Optional)" &&
    unitId.length === 36 &&
    unitId.includes("-")
      ? unitId.trim()
      : null;

  let unit = null;
  let unitName = "No Unit";
  if (cleanUnitId !== null) {
    unit = units.find((u) => u.id === cleanUnitId);
    if (!unit) return showNotification(" Selected unit not found", "error");
    unitName = unit.name;
  }

  const chargeTypeObj = window.chargeTypes.find(
    (ct) => ct.array_chargetypeid === chargeType,
  );
  const currencyObj = window.currencies.find(
    (c) => c.transactioncurrencyid === chargeCurrency,
  );
  const currencyName = currencyObj
    ? `${currencyObj.currencyname} (${currencyObj.isocurrencycode})`
    : "";
  const currencySymbol = currencyObj ? currencyObj.currencysymbol : "";
  const currencyCode = currencyObj ? currencyObj.isocurrencycode : "";
  const frequencyObj = window.frequencies.find(
    (f) => f.Value === parseInt(frequency),
  );
  let vatObj = null;
  let vatName = "";
  if (vatValue && window.vats) {
    vatObj = window.vats.find((v) => v.array_vatid === vatValue);
    if (vatObj) {
      vatName = vatObj.array_name;
      if (vatObj.array_vat) vatName += ` (${vatObj.array_vat}%)`;
    }
  }
  const frequencyLabel = frequencyObj?.Label?.UserLocalizedLabel?.Label || "";

  if (editId) {
    const chargeIndex = recurringCharges.findIndex((c) => c.id === editId);
    if (chargeIndex !== -1) {
      const _updFreqEndDate = computeFrequencyEndDate(
        startDate,
        frequency,
        prorationEnabled,
        prorationEnabledFirstCycle,
        document.getElementById("chargeFrequencyStartDate").value,
      );
      const _updFreqStartDay = extractDayFromDate(startDate);
      const _updInvoiceGenDay = extractDayFromDate(invoiceGenerationDate);
      const _updPropertyId = document.getElementById("propertyId")?.value || "";

      recurringCharges[chargeIndex] = {
        ...recurringCharges[chargeIndex],
        // Saved through the modal = reviewed by the user: drop the "Defaulted"
        // markers so later lease-date changes no longer overwrite these values.
        _defaulted: {},
        name: chargeName,
        chargeType,
        chargeTypeName: chargeTypeObj ? chargeTypeObj.array_name : "",
        amount: chargeAmount,
        currency: chargeCurrency,
        currencyName,
        currencySymbol,
        currencyCode,
        isShortTerm,
        startDate,
        endDate,
        vat: vatValue,
        vatName,
        frequency,
        frequencyName: frequencyLabel,
        invoiceGenerationDate,
        dueInDays,
        prorationEnabled,
        preFrequencyOffset,
        billableArea,
        frequencyStartDate,
        frequencyEndDate: _updFreqEndDate,
        frequencyStartDay: _updFreqStartDay,
        invoiceGenerationDay: _updInvoiceGenDay,
        propertyId: _updPropertyId,
        prorationEnabledLastCycle,
        prorationEnabledFirstCycle,
        invoiceSeparately,
        bankAccount,
        bankAccountName,
        rateRule,
        rateRuleName,
        dueDateRule,
        taxIncluded,
        exchangeRateDay: isExchangeRateDayVisible ? exchangeRateDay : null,
        invoiceType,
        invoicePrefix,
        invoicePrefixName,
        unitId: cleanUnitId,
        unitName,
        tenantId,
        tenantType,
        tenantName,
        needsAutoPopulate: false,
        needsCompletion: false,
        useAsInvoiceCurrency,
      };
      showNotification(" Charge updated successfully", "success");
    }
  } else {
    const _newFreqEndDate = computeFrequencyEndDate(
      startDate,
      frequency,
      prorationEnabled,
      prorationEnabledFirstCycle,
      document.getElementById("chargeFrequencyStartDate").value,
    );
    const _resolvedEndDate = isShortTerm ? _newFreqEndDate || "" : endDate;
    const _newFreqStartDay = extractDayFromDate(startDate);
    const _newInvoiceGenDay = extractDayFromDate(invoiceGenerationDate);
    const _newPropertyId = document.getElementById("propertyId")?.value || "";

    const charge = {
      id: "temp_" + Date.now(),
      name: chargeName,
      chargeType,
      chargeTypeName: chargeTypeObj ? chargeTypeObj.array_name : "",
      amount: chargeAmount,
      currency: chargeCurrency,
      currencyName,
      currencySymbol,
      currencyCode,
      isShortTerm,
      startDate,
      endDate,
      vat: vatValue,
      vatName,
      frequency,
      frequencyName: frequencyLabel,
      invoiceGenerationDate,
      dueInDays,
      prorationEnabled,
      preFrequencyOffset,
      billableArea,
      frequencyStartDate,
      frequencyEndDate: _newFreqEndDate,
      frequencyStartDay: _newFreqStartDay,
      invoiceGenerationDay: _newInvoiceGenDay,
      propertyId: _newPropertyId,
      prorationEnabledLastCycle,
      prorationEnabledFirstCycle,
      invoiceSeparately,
      bankAccount,
      bankAccountName,
      rateRule,
      rateRuleName,
      dueDateRule,
      taxIncluded,
      exchangeRateDay: isExchangeRateDayVisible ? exchangeRateDay : null,
      invoiceType,
      invoicePrefix,
      invoicePrefixName,
      unitId: cleanUnitId,
      unitName,
      tenantId,
      tenantType,
      tenantName,
      isExisting: false,
      useAsInvoiceCurrency,
    };
    recurringCharges.push(charge);
    showNotification(" Charge added successfully", "success");
  }

  closeModal("recurringModal");
  renderAllChargesGrid();
  setTimeout(() => {
    const previewContainer = document.getElementById(
      "invoiceDatePreviewContainer",
    );
    if (previewContainer && previewContainer.style.display !== "none") {
      updateInvoiceDatePreview();
    }
  }, 200);
}

// Save with Validation
function saveRecurringChargeWithValidation() {
  console.log(" saveRecurringCharge function called with validation");

  // Force validation of every populated date field at save time. validateAllDates
  // only evaluates fields flagged "data-user-modified", so a value set without an
  // interactive edit (or one whose warning the user ignored) could otherwise slip
  // through. Marking valued date fields here guarantees they are re-checked.
  ["chargeStartDate", "chargeEndDate", "chargeInvoiceGenerationDate"].forEach(
    (id) => {
      const f = document.getElementById(id);
      if (f && f.value) f.setAttribute("data-user-modified", "true");
    },
  );

  // First, validate all dates
  validateAllDates();

  // Check if there are any validation errors
  const startDateField = document.getElementById("chargeStartDate");
  const endDateField = document.getElementById("chargeEndDate");
  const invoiceGenDateField = document.getElementById(
    "chargeInvoiceGenerationDate",
  );

  if (startDateField && startDateField.validationMessage) {
    showNotification(" " + startDateField.validationMessage, "error");
    return;
  }

  if (endDateField && endDateField.validationMessage) {
    showNotification(" " + endDateField.validationMessage, "error");
    return;
  }

  if (invoiceGenDateField && invoiceGenDateField.validationMessage) {
    showNotification(" " + invoiceGenDateField.validationMessage, "error");
    return;
  }

  // If validation passes, proceed with existing save logic
  saveRecurringCharge();
}

// Edit recurring charge
function editRecurringCharge(charge) {
  openRecurringModal(charge.unitId, charge);
}

// Delete recurring charge (Updated)
function deleteRecurringCharge(id) {
  console.log("&#x1F5D1;&#xFE0F; Delete charge requested for ID:", id);

  showDeleteConfirm(
    "Delete Charge",
    "Are you sure you want to delete this charge?",
    () => {
      console.log(" Delete confirmed for charge ID:", id);

      // Find the charge before deletion for logging
      const chargeToDelete = recurringCharges.find((c) => c.id === id);
      if (chargeToDelete) {
        console.log(" Deleting charge:", chargeToDelete.name);
      }

      // Remove from array IMMEDIATELY
      const originalLength = recurringCharges.length;
      recurringCharges = recurringCharges.filter((c) => c.id !== id);
      const newLength = recurringCharges.length;

      console.log(` Charges array updated: ${originalLength} -> ${newLength}`);

      // If it was an existing charge from Dataverse, track it for deletion on save
      if (chargeToDelete && chargeToDelete.isExisting) {
        if (!chargesToDelete.includes(id)) {
          chargesToDelete.push(id);
          console.log(" Added to deletion queue (will delete on save):", id);
        }
      }

      // CRITICAL FIX: Re-render IMMEDIATELY after array update
      console.log(" Immediately re-rendering charges grid...");
      renderAllChargesGrid();

      // Show success notification
      showNotification(" Charge removed successfully", "success");

      // Verify the charge is gone (debugging)
      setTimeout(() => {
        const stillExists = recurringCharges.find((c) => c.id === id);
        if (stillExists) {
          console.error(" ERROR: Charge still exists in array after deletion!");
          // Force another render if somehow it's still there
          renderAllChargesGrid();
        } else {
          //  console.log(' Charge successfully removed from array and UI');
        }
      }, 100);
    },
  );
}

// Create recurring charges - returns Promise
// Sequential (previously parallel via forEach) - prevents the "multiple invoices"
// race against the webhook-triggered invoice generation flow. The webhook fires
// once per Create; by awaiting each create, triggers queue in order and the
// "Still due today" guard in that flow correctly catches siblings whose dates
// have already been advanced. The downstream call to triggerBatchInvoiceGeneration()
// in the save/send handlers is the primary invoicing path; the webhook flow is
// the fallback.
async function createRecurringCharges(leaseAgreementId, tenantId, tenantType) {
  // Save ALL charges: manually added (!isExisting) AND unit recurring charges that
  // have been auto-populated/edited (isExisting with startDate populated).
  // isExisting charges with no startDate are still raw templates - skip them.
  const newCharges = (recurringCharges || []).filter(
    (c) =>
      !c.isExisting ||
      (c.isExisting && c.startDate && c.startDate.trim() !== ""),
  );

  if (newCharges.length === 0) {
    console.log("i No new recurring charges to create.");
    return;
  }

  for (const charge of newCharges) {
    if (!charge.name || !charge.amount) {
      console.warn(
        ">> Skipping invalid charge (missing name or amount)",
        charge,
      );
      continue;
    }

    const cleanUnitId =
      charge.unitId &&
      typeof charge.unitId === "string" &&
      charge.unitId.trim() !== "" &&
      charge.unitId.length === 36 &&
      charge.unitId.includes("-") &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        charge.unitId,
      )
        ? charge.unitId.trim()
        : null;

    var chargeRecord = {};
    chargeRecord.array_chargename = charge.name;
    chargeRecord.array_amount = parseFloat(charge.amount);

    if (charge.vat && charge.vat !== "") {
      chargeRecord["array_VAT@odata.bind"] =
        "/array_vats(" + charge.vat + ")";
    }

    if (charge.invoiceGenerationDate) {
      chargeRecord.array_invoicegenerationdate = charge.invoiceGenerationDate;
    }

    if (charge.dueInDays) {
      chargeRecord.array_dueindays = parseInt(charge.dueInDays);
    }

    if (charge.startDate) {
      chargeRecord.array_startdate = charge.startDate;
    }

    if (charge.endDate && charge.endDate.trim() !== "") {
      chargeRecord.array_enddate = charge.endDate;
    }

    if (charge.frequency) {
      chargeRecord.array_frequency = parseInt(charge.frequency);
    }

    chargeRecord.array_prorationenabled =
      charge.prorationEnabled === true || charge.prorationEnabled === "true";
    chargeRecord.array_prefrequencyoffset =
      charge.preFrequencyOffset === true ||
      charge.preFrequencyOffset === "true";

    //  NEW FIELDS
    if (charge.billableArea && charge.billableArea > 0) {
      chargeRecord.array_billablearea = parseFloat(charge.billableArea);
    }

    if (charge.startDate && charge.startDate !== "") {
      chargeRecord.array_frequencystartdate = charge.startDate;
    }

    chargeRecord.array_prorationenabledforlastcycle =
      charge.prorationEnabledLastCycle === true ||
      charge.prorationEnabledLastCycle === "true";
    if (
      charge.prorationEnabledFirstCycle !== null &&
      charge.prorationEnabledFirstCycle !== undefined
    ) {
      chargeRecord.array_prorationenabledforfirstcycle =
        charge.prorationEnabledFirstCycle === true ||
        charge.prorationEnabledFirstCycle === "true";
    }
    chargeRecord.array_invoiceseparately =
      charge.invoiceSeparately === true ||
      charge.invoiceSeparately === "true";

    if (charge.bankAccount && charge.bankAccount !== "") {
      chargeRecord["array_BankAccountNumber@odata.bind"] =
        "/array_bankaccounts(" + charge.bankAccount + ")";
    }

    if (charge.rateRule && charge.rateRule !== "") {
      chargeRecord["array_RateRule@odata.bind"] =
        "/array_exchangerateselectionruleses(" + charge.rateRule + ")";
    }

    if (charge.dueDateRule !== undefined && charge.dueDateRule !== "") {
      chargeRecord.array_duedaterule = parseInt(charge.dueDateRule);
    }

    chargeRecord.array_taxincluded =
      charge.taxIncluded === true || charge.taxIncluded === "true";

    if (
      charge.exchangeRateDay !== null &&
      charge.exchangeRateDay !== undefined
    ) {
      chargeRecord.array_exchangerateday = parseInt(charge.exchangeRateDay);
    }

    // Guard with GUID validation - same pattern as saveLeaseOptions - to prevent
    // the OData "annotation-without-value" error when leaseAgreementId is missing/invalid.
    const isValidLeaseGuid =
      typeof leaseAgreementId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        leaseAgreementId.trim(),
      );
    if (isValidLeaseGuid) {
      chargeRecord["array_LeaseAgreement@odata.bind"] =
        "/array_leaseagreements(" + leaseAgreementId.trim() + ")";
    } else {
      console.warn(
        "  array_LeaseAgreement@odata.bind skipped for charge - invalid or missing leaseAgreementId:",
        leaseAgreementId,
      );
    }

    if (charge.tenantId && charge.tenantType) {
      if (charge.tenantType === "account") {
        chargeRecord["array_Tenant_account@odata.bind"] =
          "/accounts(" + charge.tenantId + ")";
      } else {
        chargeRecord["array_Tenant_contact@odata.bind"] =
          "/contacts(" + charge.tenantId + ")";
      }
    }

    if (cleanUnitId !== null) {
      chargeRecord["array_Unit@odata.bind"] =
        "/array_units(" + cleanUnitId + ")";
    }

    if (charge.chargeType) {
      chargeRecord["array_ChargeType@odata.bind"] =
        "/array_chargetypes(" + charge.chargeType + ")";
    }

    if (charge.currency) {
      chargeRecord["transactioncurrencyid@odata.bind"] =
        "/transactioncurrencies(" + charge.currency + ")";
    }

    //  Invoice Type & Invoice Prefix (Stage 3)
    if (charge.invoiceType && charge.invoiceType !== "") {
      chargeRecord["array_InvoiceType@odata.bind"] =
        "/array_invoicetypes(" + charge.invoiceType + ")";
    }
    if (charge.invoicePrefix && charge.invoicePrefix !== "") {
      chargeRecord["array_InvoicePrefix@odata.bind"] =
        "/array_invoiceprefixes(" + charge.invoicePrefix + ")";
    }

    //  Frequency End Date = end of the first cycle (first-cycle / proration logic,
    // stored on the charge when it was added). Month-to-Month charges without one
    // (e.g. unit charges filled in automatically) are counted from the charge Start Date.
    // array_enddate is NOT overwritten here: it stays the End Date from the form
    // (set above), for Month-to-Month leases too, since they now have a lease End Date.
    const _freqEnd =
      charge.frequencyEndDate && charge.frequencyEndDate !== ""
        ? charge.frequencyEndDate
        : charge.isShortTerm && charge.startDate && charge.frequency
          ? computeFrequencyEndDate(
              charge.startDate,
              charge.frequency,
              false,
              false,
              "",
            )
          : null;
    if (_freqEnd) {
      chargeRecord.array_frequencyenddate = _freqEnd;
      // Month-to-Month charge saved without an End Date: keep the old behaviour
      // (End Date = end of the first cycle) instead of leaving it empty
      if (charge.isShortTerm && !chargeRecord.array_enddate) {
        chargeRecord.array_enddate = _freqEnd;
      }
    }

    //  Upcoming Invoice Generation Day (date field - store the full date)
    if (charge.invoiceGenerationDate && charge.invoiceGenerationDate !== "") {
      chargeRecord.array_upcominginvoicegenerationday =
        charge.invoiceGenerationDate;
    }

    //  Frequency Start Day (whole number - day-of-month from frequencyStartDate)
    if (
      charge.frequencyStartDay !== null &&
      charge.frequencyStartDay !== undefined
    ) {
      chargeRecord.array_frequencystartday = charge.frequencyStartDay;
    }

    //  Invoice Generation Day (whole number - day-of-month from invoiceGenerationDate)
    if (
      charge.invoiceGenerationDay !== null &&
      charge.invoiceGenerationDay !== undefined
    ) {
      chargeRecord.array_invoicegenerationday = charge.invoiceGenerationDay;
    }

    //  Property lookup
    const _savePropertyId =
      charge.propertyId && charge.propertyId.trim() !== ""
        ? charge.propertyId.trim()
        : null;
    if (_savePropertyId) {
      chargeRecord["array_Property@odata.bind"] =
        "/array_properties(" + _savePropertyId + ")";
    }

    //  Use as Invoice Currency
    chargeRecord.array_useasinvoicecurrency =
      charge.useAsInvoiceCurrency === true;

    console.log(" ===== RECURRING CHARGE - PRE-SAVE FULL FIELD DUMP =====");
    console.log("&#x1F4CB; Charge Object (all fields):", {
      id: charge.id,
      name: charge.name,
      chargeType: charge.chargeType,
      chargeTypeName: charge.chargeTypeName,
      amount: charge.amount,
      currency: charge.currency,
      currencyName: charge.currencyName,
      currencySymbol: charge.currencySymbol,
      currencyCode: charge.currencyCode,
      startDate: charge.startDate,
      endDate: charge.endDate,
      vat: charge.vat,
      vatName: charge.vatName,
      frequency: charge.frequency,
      frequencyName: charge.frequencyName,
      invoiceGenerationDate: charge.invoiceGenerationDate,
      dueInDays: charge.dueInDays,
      dueDateRule: charge.dueDateRule,
      prorationEnabled: charge.prorationEnabled,
      prorationEnabledFirstCycle: charge.prorationEnabledFirstCycle,
      prorationEnabledLastCycle: charge.prorationEnabledLastCycle,
      preFrequencyOffset: charge.preFrequencyOffset,
      billableArea: charge.billableArea,
      frequencyStartDate: charge.frequencyStartDate,
      invoiceSeparately: charge.invoiceSeparately,
      bankAccount: charge.bankAccount, // <- GUID
      bankAccountName: charge.bankAccountName, // <- Display text
      rateRule: charge.rateRule,
      rateRuleName: charge.rateRuleName,
      taxIncluded: charge.taxIncluded,
      exchangeRateDay: charge.exchangeRateDay,
      invoiceType: charge.invoiceType,
      invoicePrefix: charge.invoicePrefix,
      invoicePrefixName: charge.invoicePrefixName,
      unitId: charge.unitId,
      unitName: charge.unitName,
      tenantId: charge.tenantId,
      tenantType: charge.tenantType,
      tenantName: charge.tenantName,
      isExisting: charge.isExisting,
      needsAutoPopulate: charge.needsAutoPopulate,
      frequencyEndDate: charge.frequencyEndDate, //  NEW
      frequencyStartDay: charge.frequencyStartDay, //  NEW
      invoiceGenerationDay: charge.invoiceGenerationDay, //  NEW
      propertyId: charge.propertyId, //  NEW
    });
    console.log(" Dataverse Payload (chargeRecord):", chargeRecord);
    console.log(" ===== END OF PRE-SAVE DUMP =====");

    try {
      const result = await XrmContext.WebApi.createRecord(
        "array_recurringcharge",
        chargeRecord,
      );
      console.log(
        " Recurring charge created: " +
          charge.name +
          " (ID: " +
          result.id +
          ")",
      );
    } catch (chargeError) {
      console.error(
        ' Error creating recurring charge "' + charge.name + '":',
        chargeError,
      );
      console.error("Failed payload was:", chargeRecord);
      throw new Error(
        'Failed to save recurring charge "' +
          charge.name +
          '": ' +
          (chargeError.message || JSON.stringify(chargeError)),
      );
    }
  }
}

// ==========================================================================
// BATCH INVOICE GENERATION TRIGGER
// Called once per lease save, AFTER all recurring charges have been created
// (sequential creation in createRecurringCharges guarantees this ordering).
//
// POSTs an empty body to the "Batch Invoice Draft Recurring Charges" HTTP
// wrapper flow. That wrapper simply invokes the existing child flow
// 'Child - List recurring charges when the invoice generation day is today',
// which discovers every lease with charges due today, groups them by
// (Lease x InvoiceType), and calls the per-charge invoice orchestrator with
// Common Invoice state carried forward -- producing one invoice per group
// instead of one invoice per charge.
//
// This runs BEFORE the locked webhook flow's 30-second debounce elapses, so
// when that flow queries for today's charges after its delay, the dates have
// already been advanced and the webhook flow finds no work to do.
//
// Setup: create a Dataverse environment variable with schema name
// 'array_BatchInvoiceDraftRecurringChargesFlowURL' and set its value to the
// HTTP POST URL of the wrapper flow trigger.
//
// Errors here are logged but NEVER thrown -- a failure here must not fail
// the lease save. If this call fails, the locked webhook flow still runs as
// a fallback (producing the pre-fix multi-invoice behaviour for that lease).
// ==========================================================================
const BATCH_INVOICE_FLOW_ENV_VAR =
  "array_BatchInvoiceDraftRecurringChargesFlowURL";

async function triggerBatchInvoiceGeneration() {
  try {
    const flowUrl = await getEnvVarValue(BATCH_INVOICE_FLOW_ENV_VAR);
    const response = await fetch(flowUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        "Batch invoice flow returned HTTP " +
          response.status +
          ": " +
          text,
      );
    }
    console.log(" Batch invoice generation triggered successfully");
  } catch (err) {
    // Fire-and-log: do NOT rethrow. The locked webhook flow acts as fallback.
    console.warn(
      " Batch invoice generation call failed - webhook flow will act as fallback:",
      err,
    );
  }
}

// CHARGE TYPE CHANGE HANDLER - AUTO-POPULATE INVOICE TYPE & PREFIX
async function handleChargeTypeChange() {
  const chargeTypeSelect = document.getElementById("chargeType");
  const propertyId = document.getElementById("propertyId")?.value || "";
  const invoiceTypeSelect = document.getElementById("chargeInvoiceType");
  const invoicePrefixDisplay = document.getElementById(
    "chargeInvoicePrefixDisplay",
  );
  const invoicePrefixHidden = document.getElementById("chargeInvoicePrefix");

  const selectedChargeTypeId = chargeTypeSelect.value;

  // Clear invoice type dropdown
  invoiceTypeSelect.innerHTML = '<option value="">Select Invoice Type</option>';
  invoicePrefixDisplay.value = "";
  invoicePrefixHidden.value = "";

  if (!selectedChargeTypeId || !propertyId) {
    updateFieldState(invoiceTypeSelect);
    updateFieldState(invoicePrefixDisplay);
    return;
  }

  try {
    // Fetch allowed invoice type IDs for this Charge Type + Property combination
    const filter = `_array_chargetype_value eq ${selectedChargeTypeId} and _array_property_value eq ${propertyId}`;
    const query = `?$select=_array_invoicetype_value&$filter=${filter}`;

    const result = await XrmContext.WebApi.retrieveMultipleRecords(
      "array_propertyinvoicetypeconfiguration",
      query,
    );

    if (!result.entities || result.entities.length === 0) {
      showNotification(
        "No Invoice Types configured for this Charge Type on the selected Property",
        "warning",
      );
      updateFieldState(invoiceTypeSelect);
      return;
    }

    // Collect allowed IDs (dedupe)
    const allowedIds = new Set(
      result.entities.map((r) => r["_array_invoicetype_value"]).filter(Boolean),
    );

    // Filter the in-memory invoice types cache
    const invoiceTypes = (window.invoiceTypes || []).filter((it) =>
      allowedIds.has(it.array_invoicetypeid),
    );

    if (invoiceTypes.length === 0) {
      showNotification(
        "No Invoice Types configured for this Charge Type on the selected Property",
        "warning",
      );
      updateFieldState(invoiceTypeSelect);
      return;
    }

    // Populate dropdown
    invoiceTypes.forEach((it) => {
      const opt = document.createElement("option");
      opt.value = it.array_invoicetypeid;
      opt.textContent = it.array_name;
      invoiceTypeSelect.appendChild(opt);
    });

    // Auto-select if only one option
    if (invoiceTypes.length === 1) {
      invoiceTypeSelect.value = invoiceTypes[0].array_invoicetypeid;
      await handleInvoiceTypeChange(); // trigger prefix population
    }

    invoiceTypeSelect.disabled = false;
    invoiceTypeSelect.style.cursor = "";
    invoiceTypeSelect.style.opacity = "";
    updateFieldState(invoiceTypeSelect);
  } catch (err) {
    console.error("Error loading filtered invoice types:", err);
    showNotification(
      "Could not load Invoice Types for this Charge Type",
      "error",
    );
  }
}
async function handleInvoiceTypeChange() {
  const invoiceTypeSelect = document.getElementById("chargeInvoiceType");
  const invoicePrefixDisplay = document.getElementById(
    "chargeInvoicePrefixDisplay",
  );
  const invoicePrefixHidden = document.getElementById("chargeInvoicePrefix");

  const selectedInvoiceTypeId = invoiceTypeSelect.value;
  if (!selectedInvoiceTypeId) {
    invoicePrefixDisplay.value = "";
    invoicePrefixHidden.value = "";
    updateFieldState(invoicePrefixDisplay);
    return;
  }

  try {
    const invoiceTypeRecord = await XrmContext.WebApi.retrieveRecord(
      "array_invoicetype",
      selectedInvoiceTypeId,
      "?$select=_array_invoiceprefix_value",
    );

    if (!invoiceTypeRecord._array_invoiceprefix_value) {
      invoicePrefixDisplay.value = "";
      invoicePrefixHidden.value = "";
      updateFieldState(invoicePrefixDisplay);
      return;
    }

    const prefixRecord = await XrmContext.WebApi.retrieveRecord(
      "array_invoiceprefix",
      invoiceTypeRecord._array_invoiceprefix_value,
      "?$select=array_invoiceprefixid,array_prefix",
    );

    invoicePrefixHidden.value = prefixRecord.array_invoiceprefixid;
    invoicePrefixDisplay.value = prefixRecord.array_prefix || "";
    updateFieldState(invoicePrefixDisplay);
  } catch (err) {
    console.error("Error fetching prefix for invoice type:", err);
    showNotification("Could not load Invoice Prefix", "warning");
  }
}

//  Handle First Cycle Proration Change - show/hide First cycle frequency End Date
function handleFirstCycleProrationChange() {
  const firstCycleEnabled =
    document.getElementById("chargeProrationEnabledFirstCycle").value ===
    "true";
  const endDateGroup = document.getElementById(
    "firstCycleFrequencyEndDateGroup",
  );
  const freqEndDateField = document.getElementById("chargeFrequencyStartDate");

  if (firstCycleEnabled) {
    endDateGroup.style.display = "block";
    // Auto-populate if not already set
    autoPopulateFrequencyStartDate();
    updateFieldState(freqEndDateField);
  } else {
    endDateGroup.style.display = "none";
    // Reset the value when first cycle proration is not chosen
    freqEndDateField.value = "";
    freqEndDateField.removeAttribute("data-user-input");
    freqEndDateField.removeAttribute("min");
    freqEndDateField.removeAttribute("max");
    updateFieldState(freqEndDateField);
  }
}

//  Handle Proration Enabled Change
function handleProrationChange() {
  const prorationEnabled =
    document.getElementById("chargeProrationEnabled").value === "true";
  const invoiceGenDateField = document.getElementById(
    "chargeInvoiceGenerationDate",
  );
  const startDateField = document.getElementById("chargeStartDate");
  const frequencyField = document.getElementById("chargeFrequency");

  // Get conditional fields
  const conditionalFields = document.getElementById(
    "prorationConditionalFields",
  );
  const prorationLastCycleField = document.getElementById(
    "chargeProrationEnabledLastCycle",
  );
  const frequencyStartDateField = document.getElementById(
    "chargeFrequencyStartDate",
  );

  if (prorationEnabled) {
    // Show conditional fields
    conditionalFields.style.display = "block";

    //  Default Proration Enabled for First Cycle = No (when newly toggled to Yes)
    const firstCycleField = document.getElementById(
      "chargeProrationEnabledFirstCycle",
    );
    if (firstCycleField && !firstCycleField.getAttribute("data-user-input")) {
      firstCycleField.value = "false";
      updateFieldState(firstCycleField);
    }

    //  Default Proration Enabled for Last Cycle = No (when newly toggled to Yes)
    if (
      prorationLastCycleField &&
      !prorationLastCycleField.getAttribute("data-user-input")
    ) {
      prorationLastCycleField.value = "false";
      updateFieldState(prorationLastCycleField);
    }

    // Make Frequency Start Date REQUIRED when Proration is enabled
    frequencyStartDateField.setAttribute("required", "required");

    //  FIXED: Auto-populate with CORRECT calculation
    autoPopulateFrequencyStartDate();

    // Unlock Invoice Generation Date - User can edit
    invoiceGenDateField.readOnly = false;
    invoiceGenDateField.disabled = false;
    invoiceGenDateField.style.backgroundColor = "";
    invoiceGenDateField.style.cursor = "";
    invoiceGenDateField.style.opacity = "1";

    // Update field states for conditional fields
    setTimeout(() => {
      updateFieldState(prorationLastCycleField);
      updateFieldState(frequencyStartDateField);
    }, 50);

    console.log(
      " Invoice Generation Date UNLOCKED + Conditional fields shown + Frequency Start Date is now REQUIRED (FIXED)",
    );
  } else {
    // Hide conditional fields
    conditionalFields.style.display = "none";

    // Clear conditional field values when hidden
    prorationLastCycleField.value = "false";
    frequencyStartDateField.value = "";

    // Reset first cycle proration and end date group
    const firstCycleField = document.getElementById(
      "chargeProrationEnabledFirstCycle",
    );
    const firstCycleEndDateGroup = document.getElementById(
      "firstCycleFrequencyEndDateGroup",
    );
    if (firstCycleField) {
      firstCycleField.value = "";
      firstCycleField.removeAttribute("data-user-input");
    }
    if (firstCycleEndDateGroup) firstCycleEndDateGroup.style.display = "none";

    // Remove user input markers so next time proration is enabled, defaults reset
    prorationLastCycleField.removeAttribute("data-user-input");
    frequencyStartDateField.removeAttribute("data-user-input");

    // Remove REQUIRED attribute when Proration is disabled
    frequencyStartDateField.removeAttribute("required");

    // Clear date range restrictions
    frequencyStartDateField.removeAttribute("min");
    frequencyStartDateField.removeAttribute("max");

    // Update field states
    updateFieldState(prorationLastCycleField);
    updateFieldState(frequencyStartDateField);

    // Invoice Generation Date remains EDITABLE (not locked)
    invoiceGenDateField.readOnly = false;
    invoiceGenDateField.disabled = false;
    invoiceGenDateField.style.backgroundColor = "";
    invoiceGenDateField.style.cursor = "";
    invoiceGenDateField.style.opacity = "1";

    console.log(
      "Invoice Generation Date remains editable + Frequency Start Date is now OPTIONAL",
    );
  }

  // Validate dates after proration change
  validateAllDates();
  updateInvoiceDatePreview();
}

//  Handle Pre Frequency Offset Change
function handlePreFrequencyOffsetChange() {
  const prorationEnabled =
    document.getElementById("chargeProrationEnabled").value === "true";

  // Validate dates after offset change
  validateAllDates();
  updateInvoiceDatePreview();
}

//  Auto-calculate Invoice Generation Date
function autoCalculateInvoiceGenDate() {
  const startDateField = document.getElementById("chargeStartDate");
  const frequencyField = document.getElementById("chargeFrequency");
  const invoiceGenDateField = document.getElementById(
    "chargeInvoiceGenerationDate",
  );
  const preFrequencyOffsetField = document.getElementById(
    "chargePreFrequencyOffset",
  );

  if (!startDateField.value || !frequencyField.value) {
    invoiceGenDateField.value = "";
    invoiceGenDateField.removeAttribute("min");
    invoiceGenDateField.removeAttribute("max");
    return;
  }

  const startDate = new Date(startDateField.value);
  const frequencyName = getFrequencyName(frequencyField.value);
  const preFrequencyOffset = preFrequencyOffsetField
    ? preFrequencyOffsetField.value === "true"
    : false;

  const FREQUENCY_DAYS = {
    126330000: 30, // Monthly
    126330001: 365, // Annually
    126330003: 1, // Daily
    126330004: 7, // Weekly
    126330005: 90, // Quarterly
    126330002: 0, // One Time
  };

  const freqValue = parseInt(frequencyField.value);
  const freqDays = FREQUENCY_DAYS[freqValue] || 0;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let calculatedDate;
  let minDate, maxDate;

  if (preFrequencyOffset) {
    calculatedDate = new Date(startDate);
    calculatedDate.setDate(calculatedDate.getDate() - 1);

    minDate = new Date(startDate);
    minDate.setDate(startDate.getDate() - freqDays * 2);

    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    if (minDate < tomorrow) {
      minDate = new Date(tomorrow);
    }

    maxDate = new Date(startDate);

    invoiceGenDateField.setAttribute("min", formatDateForInput(minDate));
    invoiceGenDateField.setAttribute("max", formatDateForInput(maxDate));
  } else {
    calculatedDate = new Date(startDate);

    if (freqValue === 126330000) {
      calculatedDate.setMonth(calculatedDate.getMonth() + 1);
      calculatedDate.setDate(calculatedDate.getDate() + 1);
    } else {
      calculatedDate.setDate(calculatedDate.getDate() + freqDays + 1);
    }

    minDate = new Date(startDate);
    maxDate = new Date(startDate);
    maxDate.setDate(startDate.getDate() + freqDays * 2);

    //  Never allow past dates: ensure minDate is at least today
    if (minDate < today) {
      minDate = new Date(today);
    }

    invoiceGenDateField.setAttribute("min", formatDateForInput(minDate));
    invoiceGenDateField.setAttribute("max", formatDateForInput(maxDate));
  }

  // Set the calculated date WITHOUT marking as user-modified
  //  Never set a past date: clamp calculatedDate to today minimum
  if (calculatedDate < today) {
    calculatedDate = new Date(today);
  }
  invoiceGenDateField.value = formatDateForInput(calculatedDate);

  //  Mark as user input so preview will trigger
  invoiceGenDateField.setAttribute("data-user-input", "true");
  updateFieldState(invoiceGenDateField);

  //  Immediately trigger preview update after auto-calculation
  setTimeout(() => {
    updateInvoiceDatePreview();
  }, 50);
}

//  Auto-populate Frequency Start Date when Proration is enabled
function autoPopulateFrequencyStartDate() {
  const startDateField = document.getElementById("chargeStartDate");
  const frequencyField = document.getElementById("chargeFrequency");
  const frequencyStartDateField = document.getElementById(
    "chargeFrequencyStartDate",
  );
  const prorationEnabled =
    document.getElementById("chargeProrationEnabled").value === "true";

  if (!prorationEnabled || !startDateField.value || !frequencyField.value) {
    return;
  }

  const startDate = new Date(startDateField.value);
  const frequencyValue = parseInt(frequencyField.value);

  //  FIXED: Get frequency in DAYS (not months)
  const FREQUENCY_DAYS = {
    126330000: 30, // Monthly
    126330001: 365, // Annually
    126330003: 1, // Daily
    126330004: 7, // Weekly
    126330005: 90, // Quarterly
    126330002: 0, // One Time
  };

  const freqDays = FREQUENCY_DAYS[frequencyValue];

  if (freqDays > 0) {
    //  CORRECT FORMULA: Start Date + Frequency - 1 DAY
    const frequencyStartDate = new Date(startDate);
    frequencyStartDate.setDate(frequencyStartDate.getDate() + freqDays - 1);

    // Set the calculated date
    frequencyStartDateField.value = formatDateForInput(frequencyStartDate);
    frequencyStartDateField.setAttribute("data-user-input", "true");

    //  FIXED: Set CORRECT date range (Start Date to Start Date + Frequency - 1 day)
    setFrequencyStartDateRange(startDate, freqDays);

    updateFieldState(frequencyStartDateField);

    console.log(" Frequency Start Date auto-populated (FIXED):", {
      startDate: formatDateForInput(startDate),
      frequencyDays: freqDays,
      calculatedDate: formatDateForInput(frequencyStartDate),
      formula: `${formatDateForInput(startDate)} + ${freqDays} days - 1 day`,
    });
  } else {
    // For Daily/Weekly/One Time, don't auto-populate
    frequencyStartDateField.value = "";
    // Clear date range restrictions
    frequencyStartDateField.removeAttribute("min");
    frequencyStartDateField.removeAttribute("max");
  }
}

//  Set date range for Frequency Start Date field
function setFrequencyStartDateRange(startDate, frequencyDays) {
  const frequencyStartDateField = document.getElementById(
    "chargeFrequencyStartDate",
  );

  if (!frequencyStartDateField || frequencyDays <= 0) {
    return;
  }

  //  CORRECT RANGE:
  // Min: Start Date
  const minDate = new Date(startDate);

  // Max: Start Date + Frequency - 1 day
  const maxDate = new Date(startDate);
  maxDate.setDate(maxDate.getDate() + frequencyDays - 1);

  frequencyStartDateField.setAttribute("min", formatDateForInput(minDate));
  frequencyStartDateField.setAttribute("max", formatDateForInput(maxDate));

  console.log(" Frequency Start Date range set (FIXED):", {
    min: formatDateForInput(minDate),
    max: formatDateForInput(maxDate),
    frequencyDays: frequencyDays,
    calculation: `Start Date (${formatDateForInput(
      minDate,
    )}) to Start Date + ${frequencyDays} days - 1 day (${formatDateForInput(
      maxDate,
    )})`,
  });
}

//  Add event listeners for auto-calculation
function setupInvoiceGenAutoCalculation() {
  const startDateField = document.getElementById("chargeStartDate");
  const frequencyField = document.getElementById("chargeFrequency");
  const endDateField = document.getElementById("chargeEndDate");
  const invoiceGenDateField = document.getElementById(
    "chargeInvoiceGenerationDate",
  );
  const preFreqOffsetField = document.getElementById(
    "chargePreFrequencyOffset",
  );
  const prorationEnabledField = document.getElementById(
    "chargeProrationEnabled",
  );

  // Track user modifications on date fields
  if (startDateField) {
    startDateField.addEventListener("input", function () {
      this.setAttribute("data-user-modified", "true");
    });

    startDateField.addEventListener("change", function () {
      this.setAttribute("data-user-modified", "true");
      const prorationEnabled = prorationEnabledField.value === "true";

      // Auto-populate frequency start date if proration enabled
      if (prorationEnabled) {
        autoPopulateFrequencyStartDate();
      }

      validateAllDates();
    });
  }

  if (endDateField) {
    endDateField.addEventListener("input", function () {
      this.setAttribute("data-user-modified", "true");
    });

    endDateField.addEventListener("change", function () {
      this.setAttribute("data-user-modified", "true");
      validateAllDates();
    });
  }

  if (invoiceGenDateField) {
    invoiceGenDateField.addEventListener("input", function () {
      this.setAttribute("data-user-modified", "true");
    });

    invoiceGenDateField.addEventListener("change", function () {
      this.setAttribute("data-user-modified", "true");
      validateAllDates();
      updateInvoiceDatePreview(); //  NEW: Update preview when manually changed
    });
  }

  if (frequencyField) {
    frequencyField.addEventListener("change", function () {
      const prorationEnabled = prorationEnabledField.value === "true";

      // Auto-populate frequency start date if proration enabled
      if (prorationEnabled) {
        autoPopulateFrequencyStartDate();
      }

      handleFrequencyVisibility();
      validateAllDates();
      updateInvoiceDatePreview();
    });
  }

  if (preFreqOffsetField) {
    preFreqOffsetField.addEventListener("change", function () {
      handlePreFrequencyOffsetChange();
      updateInvoiceDatePreview(); //  NEW: Update preview
    });
  }
}

// Handle frequency-dependent field visibility
function handleFrequencyVisibility() {
  const frequencySelect = document.getElementById("chargeFrequency");
  const selectedOption = frequencySelect.options[frequencySelect.selectedIndex];
  const frequencyText = selectedOption
    ? selectedOption.textContent.toLowerCase()
    : "";
  const frequencyValue = selectedOption ? parseInt(selectedOption.value) : null;

  const prorationGroup = document
    .getElementById("chargeProrationEnabled")
    ?.closest(".form-group");
  const preFrequencyOffsetGroup = document
    .getElementById("chargePreFrequencyOffset")
    ?.closest(".form-group");

  const isDaily =
    frequencyValue === 126330003 || frequencyText.includes("daily");
  const isOneTime =
    frequencyValue === 126330002 || frequencyText.includes("one time");

  if (isDaily) {
    if (prorationGroup) {
      prorationGroup.style.display = "none";
      document.getElementById("chargeProrationEnabled").value = "false";
    }
    if (preFrequencyOffsetGroup) {
      preFrequencyOffsetGroup.style.display = "";
    }
    const conditionalFields = document.getElementById(
      "prorationConditionalFields",
    );
    if (conditionalFields) {
      conditionalFields.style.display = "none";
    }
    console.log(
      " Daily frequency selected - hiding proration only, keeping Pre-Frequency Offset",
    );
  } else if (isOneTime) {
    if (prorationGroup) {
      prorationGroup.style.display = "none";
      document.getElementById("chargeProrationEnabled").value = "false";
    }
    if (preFrequencyOffsetGroup) {
      preFrequencyOffsetGroup.style.display = "none";
      document.getElementById("chargePreFrequencyOffset").value = "false";
    }
    const conditionalFields = document.getElementById(
      "prorationConditionalFields",
    );
    if (conditionalFields) {
      conditionalFields.style.display = "none";
    }
    console.log(
      ">> One Time frequency selected - hiding proration and Pre-Frequency Offset fields",
    );
  } else {
    if (prorationGroup) {
      prorationGroup.style.display = "";
    }
    if (preFrequencyOffsetGroup) {
      preFrequencyOffsetGroup.style.display = "";
    }
    console.log(
      " Recurring frequency selected - showing proration and Pre-Frequency Offset fields",
    );
  }

  updateInvoiceDatePreview();
}

// Calculate and display invoice generation and due dates
function updateInvoiceDatePreview() {
  const container = document.getElementById("invoiceDatePreviewContainer");
  const startDateField = document.getElementById("chargeStartDate");
  const amountField = document.getElementById("chargeAmount");
  const frequencyField = document.getElementById("chargeFrequency");
  const invoiceGenDateField = document.getElementById(
    "chargeInvoiceGenerationDate",
  );
  const dueInDaysField = document.getElementById("chargeDueInDays");
  const currencyField = document.getElementById("chargeCurrency");
  const prorationEnabledField = document.getElementById(
    "chargeProrationEnabled",
  );
  const preFrequencyOffsetField = document.getElementById(
    "chargePreFrequencyOffset",
  );
  const frequencyStartDateField = document.getElementById(
    "chargeFrequencyStartDate",
  );

  // Get values
  const startDate = startDateField.value;
  const amount = parseFloat(amountField.value);
  const frequencyValue = frequencyField.value;
  const invoiceGenDate = invoiceGenDateField.value;
  const dueInDays =
    dueInDaysField.value !== "" ? parseInt(dueInDaysField.value) : null;
  const prorationEnabled = prorationEnabledField.value === "true";
  const preFrequencyOffset = preFrequencyOffsetField.value === "true";
  const frequencyStartDate = frequencyStartDateField.value;

  // Check mandatory fields - Allow dueInDays to be 0
  if (!startDate || !amount || !frequencyValue || !currencyField.value) {
    container.style.display = "none";
    return;
  }

  // Allow due days to be 0 or any positive number
  if (dueInDays === null || dueInDays === undefined || dueInDays < 0) {
    container.style.display = "none";
    return;
  }

  // Get frequency name
  const frequencyName = getFrequencyName(frequencyValue);
  if (!frequencyName) {
    container.style.display = "none";
    return;
  }

  // Hide preview for "One Time Charge"
  if (frequencyName.toLowerCase().includes("one time")) {
    console.log(">> Skipping preview - One Time Charge selected");
    container.style.display = "none";
    return;
  }

  // Check if Invoice Generation Date exists
  if (!invoiceGenDate) {
    container.style.display = "none";
    return;
  }

  // Get currency symbol and code
  const currencySelect = document.getElementById("chargeCurrency");
  const selectedCurrencyId = currencySelect.value;

  let currencySymbol = "EUR ";
  let currencyCode = "EUR";

  if (window.currencies && selectedCurrencyId) {
    const selectedCurrency = window.currencies.find(
      (c) => c.transactioncurrencyid === selectedCurrencyId,
    );
    if (selectedCurrency) {
      currencySymbol =
        selectedCurrency.currencysymbol ||
        selectedCurrency.isocurrencycode ||
        "EUR ";
      currencyCode = selectedCurrency.isocurrencycode || "EUR";
    }
  }

  // Get charge type name
  const chargeTypeSelect = document.getElementById("chargeType");
  const selectedChargeType =
    chargeTypeSelect.options[chargeTypeSelect.selectedIndex];
  const chargeTypeName =
    selectedChargeType &&
    selectedChargeType.textContent !== "Select charge type"
      ? selectedChargeType.textContent
      : "Charge";

  // Calculate proration amount for current charge (if enabled)
  let currentChargeProrationAmount = 0;
  let currentChargeProrationDays = 0;

  if (prorationEnabled && startDate && frequencyStartDate) {
    const start = new Date(startDate);
    const freqStart = new Date(frequencyStartDate);
    const timeDiff = freqStart.getTime() - start.getTime();
    currentChargeProrationDays = Math.ceil(timeDiff / (1000 * 3600 * 24));

    if (currentChargeProrationDays === 0) {
      currentChargeProrationDays = 1;
    }

    if (currentChargeProrationDays > 0) {
      currentChargeProrationAmount = (amount / 30) * currentChargeProrationDays;
    }
  }

  // Invoice Date = Invoice Generation Date
  const invoiceGenerationDate = new Date(invoiceGenDate);

  if (isNaN(invoiceGenerationDate.getTime())) {
    console.error("Invalid invoice generation date");
    container.style.display = "none";
    return;
  }

  const invoiceDate = new Date(invoiceGenerationDate);

  // -- Resolve selected due date rule label ----------------------------------
  const dueDateRuleSelect = document.getElementById("chargeDueDateRule");
  let dueDateRuleLabel = "";
  if (dueDateRuleSelect && dueDateRuleSelect.value && window.dueDateRules) {
    const selectedRule = window.dueDateRules.find(
      (r) => String(r.Value) === String(dueDateRuleSelect.value),
    );
    if (selectedRule) {
      dueDateRuleLabel = (
        selectedRule.Label?.UserLocalizedLabel?.Label ||
        selectedRule.Label?.LocalizedLabels?.[0]?.Label ||
        ""
      ).toLowerCase();
    }
  }

  // -- Compute Due Date based on rule ----------------------------------------
  const invoiceDay = invoiceDate.getDate(); // day-of-month of invoice gen date
  const invoiceMon = invoiceDate.getMonth(); // 0-based month
  const invoiceYear = invoiceDate.getFullYear();

  let dueDate = new Date(invoiceDate);

  if (dueDateRuleLabel.includes("of the issue of the sales document")) {
    // Rule 1 - "Of the issue of the sales document"
    // Due = invoiceGenerationDate + dueInDays  (original behaviour)
    dueDate.setDate(dueDate.getDate() + dueInDays);
  } else if (
    dueDateRuleLabel.includes("of the receipt of the sales document")
  ) {
    // Rule 2 - "Of the receipt of the sales document"
    // Due date is calculated after invoice is sent; keep dueDate = invoiceDate as a
    // representative date but show a different message (no concrete date).
    dueDate = null;
  } else if (dueDateRuleLabel.includes("second month following the issue")) {
    // Rule 5 - "On the specific day of the second month following the issue of the sales document"
    // Due day = dueInDays, always in the second month after invoice generation
    const targetMonth = invoiceMon + 2;
    const targetYear = invoiceYear + Math.floor(targetMonth / 12);
    dueDate = new Date(targetYear, targetMonth % 12, dueInDays);
  } else if (dueDateRuleLabel.includes("month following the issue")) {
    // Rule 4 - "On a specific day of the month following the issue of the sales document"
    // Due day = dueInDays, always in the next month after invoice generation
    const targetMonth = invoiceMon + 1;
    const targetYear = invoiceYear + Math.floor(targetMonth / 12);
    dueDate = new Date(targetYear, targetMonth % 12, dueInDays);
  } else if (dueDateRuleLabel.includes("on a specific day of the month")) {
    // Rule 3 - "On a specific day of the month"
    // If dueInDays < invoiceDay  -> use (invoiceMon + 1) / same year
    // If dueInDays >= invoiceDay -> use same month / same year
    if (dueInDays < invoiceDay) {
      const targetMonth = invoiceMon + 1;
      const targetYear = invoiceYear + Math.floor(targetMonth / 12);
      dueDate = new Date(targetYear, targetMonth % 12, dueInDays);
    } else {
      dueDate = new Date(invoiceYear, invoiceMon, dueInDays);
    }
  } else {
    // Default / fallback - original behaviour
    dueDate.setDate(dueDate.getDate() + dueInDays);
  }

  if (
    isNaN(invoiceDate.getTime()) ||
    (dueDate !== null && isNaN(dueDate.getTime()))
  ) {
    console.error("Invalid calculated dates");
    container.style.display = "none";
    return;
  }

  // Format dates for display
  const formatDate = (date) => {
    if (!date || isNaN(date.getTime())) return "-";
    try {
      const options = { year: "numeric", month: "short", day: "numeric" };
      return date.toLocaleDateString("en-US", options);
    } catch (error) {
      console.error("Error formatting date for display:", error);
      return "-";
    }
  };

  //  NEW: Format dates for comparison (YYYY-MM-DD)
  const formatDateForComparison = (date) => {
    if (!date || isNaN(date.getTime())) return null;
    try {
      return date.toISOString().split("T")[0];
    } catch (error) {
      console.error("Error formatting date for comparison:", error);
      return null;
    }
  };

  const currentEditId = document.getElementById("chargeEditId").value;
  const calculatedInvoiceDate = formatDateForComparison(invoiceDate);
  const calculatedDueDate = formatDateForComparison(dueDate);

  //  NEW: Find matching charges with same invoice and due dates
  let matchingCharges = [];
  if (calculatedInvoiceDate && calculatedDueDate) {
    matchingCharges = recurringCharges.filter((charge) => {
      // Skip current charge being edited
      if (currentEditId && charge.id === currentEditId) return false;

      // Skip if missing required fields
      if (
        !charge.startDate ||
        !charge.frequency ||
        !charge.dueInDays ||
        !charge.invoiceGenerationDate
      ) {
        return false;
      }

      // Skip one-time charges
      const chargeFrequencyName = getFrequencyName(charge.frequency);
      if (chargeFrequencyName.toLowerCase().includes("one time")) {
        return false;
      }

      try {
        const chargeInvoiceGenDate = new Date(charge.invoiceGenerationDate);
        if (isNaN(chargeInvoiceGenDate.getTime())) {
          return false;
        }

        // Calculate charge's invoice date (same logic as current charge)
        const chargeInvoiceDate = new Date(chargeInvoiceGenDate);
        const chargeDueDate = new Date(chargeInvoiceDate);
        chargeDueDate.setDate(
          chargeDueDate.getDate() + (charge.dueInDays || 0),
        );

        if (
          isNaN(chargeInvoiceDate.getTime()) ||
          isNaN(chargeDueDate.getTime())
        ) {
          return false;
        }

        const chargeInvoiceDateStr = formatDateForComparison(chargeInvoiceDate);
        const chargeDueDateStr = formatDateForComparison(chargeDueDate);

        if (!chargeInvoiceDateStr || !chargeDueDateStr) {
          return false;
        }

        // Match if invoice date AND due date are the same
        return (
          chargeInvoiceDateStr === calculatedInvoiceDate &&
          chargeDueDateStr === calculatedDueDate
        );
      } catch (error) {
        console.error("Error processing charge for matching:", error);
        return false;
      }
    });
  }

  //  NEW: Group matching charges by currency and calculate totals
  const totalsByCurrency = {};

  matchingCharges.forEach((matchingCharge) => {
    const chargeCurrency = matchingCharge.currencyCode || "UNKNOWN";

    if (!totalsByCurrency[chargeCurrency]) {
      totalsByCurrency[chargeCurrency] = {
        symbol: matchingCharge.currencySymbol || "",
        total: 0,
      };
    }

    // Add prorated or full amount
    if (
      matchingCharge.prorationEnabled &&
      matchingCharge.startDate &&
      matchingCharge.invoiceGenerationDate
    ) {
      const chargeStart = new Date(matchingCharge.startDate);
      const chargeInvoiceGen = new Date(matchingCharge.invoiceGenerationDate);
      const chargeTimeDiff = chargeInvoiceGen.getTime() - chargeStart.getTime();
      let chargeDays = Math.ceil(chargeTimeDiff / (1000 * 3600 * 24));

      if (chargeDays === 0) chargeDays = 1;

      const chargeProrationAmount = (matchingCharge.amount / 30) * chargeDays;
      totalsByCurrency[chargeCurrency].total += chargeProrationAmount;
    } else {
      totalsByCurrency[chargeCurrency].total += matchingCharge.amount;
    }
  });

  // Add current charge to totals
  if (!totalsByCurrency[currencyCode]) {
    totalsByCurrency[currencyCode] = {
      symbol: currencySymbol,
      total: 0,
    };
  }
  const displayAmount =
    prorationEnabled && currentChargeProrationAmount > 0
      ? currentChargeProrationAmount
      : amount;
  totalsByCurrency[currencyCode].total += displayAmount;

  // Build totals display (e.g., "EUR 1,200.00 | $500.00 | zl3,000.00")
  const totalsHtml = Object.entries(totalsByCurrency)
    .map(([code, data]) => `${data.symbol}${data.total.toFixed(2)}`)
    .join(" | ");

  const hasMatchingCharges = matchingCharges.length > 0;

  //  Build invoice generation sentence
  let invoiceSentence = "";
  if (!hasMatchingCharges) {
    invoiceSentence = `An invoice for <strong style="color: #0f172a; font-weight: 700;">${currencySymbol}${displayAmount.toFixed(2)} ${currencyCode}</strong> will be generated <strong style="color: var(--blue); font-weight: 700;">${frequencyName.toLowerCase()}</strong> for this <strong style="color: var(--blue); font-weight: 700;">${escapeHtml(chargeTypeName)}</strong> charge, starting on <strong style="color: #0f172a; font-weight: 700;">${formatDate(invoiceDate)}</strong>.`;

    if (prorationEnabled && currentChargeProrationAmount > 0) {
      invoiceSentence += `<div style="margin-top: 12px; padding: 10px; background: #fff3cd; border-left: 4px solid #f59e0b; border-radius: 6px;"><span style="color: #92400e; font-weight: 600; font-size: 13px;"> Proration: ${currentChargeProrationDays} day${currentChargeProrationDays !== 1 ? "s" : ""} x ${currencySymbol}${(amount / 30).toFixed(2)}/day = ${currencySymbol}${currentChargeProrationAmount.toFixed(2)}</span></div>`;
    }
  } else {
    invoiceSentence = `This <strong style="color: var(--blue); font-weight: 700;">${currencySymbol}${displayAmount.toFixed(2)} ${currencyCode}</strong> <strong style="color: var(--blue); font-weight: 700;">${escapeHtml(chargeTypeName.toLowerCase())}</strong> charge will be added to <strong style="color: var(--blue); font-weight: 700;">${matchingCharges.length === 1 ? "one" : matchingCharges.length}</strong> other charge${matchingCharges.length > 1 ? "s" : ""}, totaling <strong style="color: #0f172a; font-weight: 700;">${totalsHtml}</strong>. The combined invoice for these <strong style="color: var(--blue); font-weight: 700;">${matchingCharges.length + 1}</strong> charges will be generated <strong style="color: var(--blue); font-weight: 700;">${frequencyName.toLowerCase()}</strong>, starting on <strong style="color: #0f172a; font-weight: 700;">${formatDate(invoiceDate)}</strong>.`;

    if (prorationEnabled && currentChargeProrationAmount > 0) {
      invoiceSentence += `<div style="margin-top: 12px; padding: 10px; background: #fff3cd; border-left: 4px solid #f59e0b; border-radius: 6px;"><span style="color: #92400e; font-weight: 600; font-size: 13px;"> This charge proration: ${currentChargeProrationDays} day${currentChargeProrationDays !== 1 ? "s" : ""} x ${currencySymbol}${(amount / 30).toFixed(2)}/day = ${currencySymbol}${currentChargeProrationAmount.toFixed(2)}</span></div>`;
    }
  }

  // -- Build payment deadline sentence (rule-aware) --------------------------
  const _amountHtml = `<strong style="color: #0f172a; font-weight: 700;">${currencySymbol}${displayAmount.toFixed(2)} ${currencyCode}</strong>`;
  const _chargeHtml = `<strong style="color: #c5350e; font-weight: 700;">${escapeHtml(chargeTypeName)}</strong>`;
  const _freqHtml = `<strong style="color: #c5350e; font-weight: 700;">${frequencyName.toLowerCase()}</strong>`;
  const _dueDays = `<strong style="color: #c5350e; font-weight: 700;">${dueInDays} day${dueInDays !== 1 ? "s" : ""}</strong>`;
  const _dueDateHtml = dueDate
    ? `<strong style="color: #0f172a; font-weight: 700;">${formatDate(dueDate)}</strong>`
    : "";

  // Prefix shared by both single-charge and combined-charge variants
  const _prefix = !hasMatchingCharges
    ? `Payment of ${_amountHtml} for the ${_chargeHtml} charge is due ${_freqHtml}.`
    : `This ${_amountHtml} <strong style="color: #c5350e; font-weight: 700;">${chargeTypeName.toLowerCase()}</strong> charge will be added to <strong style="color: #c5350e; font-weight: 700;">${matchingCharges.length === 1 ? "one" : matchingCharges.length}</strong> other charge${matchingCharges.length > 1 ? "s" : ""}, totaling <strong style="color: #0f172a; font-weight: 700;">${totalsHtml}</strong>. The combined payment for these <strong style="color: #c5350e; font-weight: 700;">${matchingCharges.length + 1 === 2 ? "two" : matchingCharges.length + 1}</strong> charges is due ${_freqHtml}.`;

  let paymentSentence = "";

  if (dueDateRuleLabel.includes("of the issue of the sales document")) {
    // Rule 1 - "Of the issue of the sales document"
    paymentSentence = `${_prefix} The next payment deadline for this charge is ${_dueDateHtml}, which is ${_dueDays} after the invoice is generated.`;
  } else if (
    dueDateRuleLabel.includes("of the receipt of the sales document")
  ) {
    // Rule 2 - "Of the receipt of the sales document"
    paymentSentence = `${_prefix} The next payment deadline for this charge will be generated after the invoice is sent to the tenant, which is ${_dueDays} from the invoice receipt date.`;
  } else if (dueDateRuleLabel.includes("second month following the issue")) {
    // Rule 5 - "On the specific day of the second month following the issue of the sales document"
    paymentSentence = `${_prefix} The next payment deadline for this charge is ${_dueDateHtml}.`;
  } else if (dueDateRuleLabel.includes("month following the issue")) {
    // Rule 4 - "On the specific day of the month following the issue of the sales document"
    paymentSentence = `${_prefix} The next payment deadline for this charge is ${_dueDateHtml}.`;
  } else if (dueDateRuleLabel.includes("on a specific day of the month")) {
    // Rule 3 - "On a specific day of the month"
    paymentSentence = `${_prefix} The next payment deadline for this charge is ${_dueDateHtml}.`;
  } else {
    // Default / fallback
    if (!hasMatchingCharges) {
      paymentSentence = `${_prefix} The next payment deadline for this charge is ${_dueDateHtml}, which is <strong style="color: #c5350e; font-weight: 700;">${dueInDays === 0 ? "on the same day" : `${dueInDays} day${dueInDays !== 1 ? "s" : ""} after`}</strong> the invoice is generated.`;
    } else {
      paymentSentence = `${_prefix} The next payment deadline is ${_dueDateHtml}, which is ${_dueDays} after the invoice is generated.`;
    }
  }

  //  Build HTML
  const previewHTML = `
<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 24px;">
  
  <!-- INVOICE GENERATION CARD -->
  <div style="
    background: var(--surf);
    border: 1px solid var(--border);
    border-top: 3px solid var(--blue);
    border-radius: var(--radius);
    overflow: hidden;
    box-shadow: var(--shadow);
  ">
    <!-- Header -->
    <div style="
      padding: 14px 18px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      gap: 12px;
    ">
      <div style="
        background: var(--blue-l);
        width: 36px;
        height: 36px;
        border-radius: 9px;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      ">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1C6BD4" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
        </svg>
      </div>
      <h4 style="
        color: var(--text);
        font-size: 13px;
        font-weight: 800;
        margin: 0;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      ">Invoice Generation</h4>
    </div>

    <!-- Content -->
    <div style="padding: 18px;">
      <div style="
        font-size: 13.5px;
        color: var(--sub);
        line-height: 1.75;
        font-weight: 500;
      ">
        ${invoiceSentence}
      </div>
    </div>
  </div>

  <!-- PAYMENT DEADLINE CARD -->
  <div style="
    background: var(--surf);
    border: 1px solid var(--border);
    border-top: 3px solid var(--amber-mid);
    border-radius: var(--radius);
    overflow: hidden;
    box-shadow: var(--shadow);
  ">
    <!-- Header -->
    <div style="
      padding: 14px 18px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      gap: 12px;
    ">
      <div style="
        background: var(--amber-l);
        width: 36px;
        height: 36px;
        border-radius: 9px;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      ">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#7A4F0A" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
          <rect x="1" y="4" width="22" height="16" rx="2" ry="2"/>
          <line x1="1" y1="10" x2="23" y2="10"/>
        </svg>
      </div>
      <h4 style="
        color: var(--text);
        font-size: 13px;
        font-weight: 800;
        margin: 0;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      ">Payment Deadline</h4>
    </div>

    <!-- Content -->
    <div style="padding: 18px;">
      <div style="
        font-size: 13.5px;
        color: var(--sub);
        line-height: 1.75;
        font-weight: 500;
      ">
        ${paymentSentence}
      </div>
    </div>
  </div>

</div>
`;

  container.innerHTML = previewHTML;
  container.style.display = "block";
}

// Get Frequency Name from Value
function getFrequencyName(frequencyValue) {
  if (!window.frequencies) return "";

  const frequencyObj = window.frequencies.find(
    (f) => f.Value === parseInt(frequencyValue),
  );

  return frequencyObj &&
    frequencyObj.Label &&
    frequencyObj.Label.UserLocalizedLabel
    ? frequencyObj.Label.UserLocalizedLabel.Label
    : "";
}

// Helper function to add time based on frequency
function addToTime(date, frequencyName) {
  const newDate = new Date(date);
  const freq = frequencyName.toLowerCase();

  switch (freq) {
    case "daily":
      newDate.setDate(newDate.getDate() + 1);
      break;
    case "weekly":
      newDate.setDate(newDate.getDate() + 7);
      break;
    case "monthly":
      newDate.setMonth(newDate.getMonth() + 1);
      break;
    case "quarterly":
      newDate.setMonth(newDate.getMonth() + 3);
      break;
    case "semi-annual":
    case "semi annual":
      newDate.setMonth(newDate.getMonth() + 6);
      break;
    case "annual":
    case "yearly":
      newDate.setFullYear(newDate.getFullYear() + 1);
      break;
    default:
      console.warn(`Unknown frequency: ${freq}, defaulting to monthly`);
      newDate.setMonth(newDate.getMonth() + 1);
  }

  return newDate;
}

// Validate all dates when any date field changes
function validateAllDates() {
  const FREQUENCY_VALS = {
    ONE_TIME: 126330002,
    MONTHLY: 126330000,
    ANNUALLY: 126330001,
    DAILY: 126330003,
    WEEKLY: 126330004,
    QUARTERLY: 126330005,
  };

  const FREQUENCY_DAYS = {
    126330000: 30,
    126330001: 365,
    126330003: 1,
    126330004: 7,
    126330005: 90,
    126330002: 0,
  };

  clearDateValidations();

  const offsetField = document.getElementById("chargePreFrequencyOffset");
  const offset = offsetField ? offsetField.value === "true" : false;

  const frequencyField = document.getElementById("chargeFrequency");
  const frequency = frequencyField ? parseInt(frequencyField.value) : null;

  const startDateField = document.getElementById("chargeStartDate");
  const startDate = startDateField ? startDateField.value : null;

  const endDateField = document.getElementById("chargeEndDate");
  const endDate = endDateField ? endDateField.value : null;

  const invGenDateField = document.getElementById(
    "chargeInvoiceGenerationDate",
  );
  const invGenDate = invGenDateField ? invGenDateField.value : null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const freqDays =
    frequency && FREQUENCY_DAYS[frequency] ? FREQUENCY_DAYS[frequency] : 0;

  // ============================================================
  // CHANGE 3: One Time Charge - validate invoice gen >= start date
  // before returning (previously was a bare return with no checks)
  // ============================================================
  if (frequency === FREQUENCY_VALS.ONE_TIME) {
    if (
      invGenDate &&
      startDate &&
      invGenDateField.hasAttribute("data-user-modified")
    ) {
      const invGenNorm = new Date(invGenDate);
      invGenNorm.setHours(0, 0, 0, 0);
      const startNorm = new Date(startDate);
      startNorm.setHours(0, 0, 0, 0);

      if (invGenNorm < today) {
        showDateValidationError(
          "chargeInvoiceGenerationDate",
          "Invoice Generation Date cannot be in the past. Please select today or a future date.",
        );
        return;
      }

      if (invGenNorm < startNorm) {
        showDateValidationError(
          "chargeInvoiceGenerationDate",
          `Invoice Generation Date cannot be before Start Date for One Time Charge (${formatDateDisplay(startNorm)}).`,
        );
      }
    }
    return;
  }

  const leaseStartDate = document.getElementById("startDate")?.value || null;
  const leaseEndDate = document.getElementById("endDate")?.value || null;

  // --- VALIDATION A: Start Date ---
  if (startDate && startDateField.hasAttribute("data-user-modified")) {
    const startNorm = new Date(startDate);
    startNorm.setHours(0, 0, 0, 0);

    if (leaseStartDate) {
      const leaseStartNorm = new Date(leaseStartDate);
      leaseStartNorm.setHours(0, 0, 0, 0);
      if (startNorm < leaseStartNorm) {
        showDateValidationError(
          "chargeStartDate",
          `Charge Start Date cannot be before the Lease Start Date (${formatDateDisplay(leaseStartNorm)}).`,
        );
      }
    }

    // ============================================================
    // CHANGE 1: Start Date offset=YES restriction (NEW - did not exist before)
    // When offset YES, start date must be at least today + 2 days
    // ============================================================
    if (offset === true) {
      const minStart = new Date(today);
      minStart.setDate(minStart.getDate() + 2);
      minStart.setHours(0, 0, 0, 0);

      if (startNorm < minStart) {
        showDateValidationError(
          "chargeStartDate",
          `With Pre-Frequency Offset set to 'Yes', Start Date must be at least ${formatDateDisplay(minStart)} (today + 2 days).`,
        );
      }
    }
  }

  // --- VALIDATION B: End Date ---
  if (startDate && endDate && endDateField.hasAttribute("data-user-modified")) {
    const endNorm = new Date(endDate);
    endNorm.setHours(0, 0, 0, 0);

    if (freqDays > 0) {
      const minEndDate = new Date(startDate);
      minEndDate.setDate(minEndDate.getDate() + freqDays);
      minEndDate.setHours(0, 0, 0, 0);
      if (endNorm < minEndDate) {
        showDateValidationError(
          "chargeEndDate",
          `End Date must be at least ${freqDays} days after the Start Date based on the chosen Frequency.`,
        );
      }
    }

    if (leaseEndDate) {
      const leaseEndNorm = new Date(leaseEndDate);
      leaseEndNorm.setHours(0, 0, 0, 0);
      if (endNorm > leaseEndNorm) {
        showDateValidationError(
          "chargeEndDate",
          `Charge End Date cannot be after the Lease End Date (${formatDateDisplay(leaseEndNorm)}).`,
        );
      }
    }
  }

  // --- VALIDATION C: Invoice Generation Date ---
  if (
    invGenDate &&
    startDate &&
    invGenDateField.hasAttribute("data-user-modified")
  ) {
    const invGenNorm = new Date(invGenDate);
    invGenNorm.setHours(0, 0, 0, 0);
    const startNorm = new Date(startDate);
    startNorm.setHours(0, 0, 0, 0);

    if (invGenNorm < today) {
      showDateValidationError(
        "chargeInvoiceGenerationDate",
        "Invoice Generation Date cannot be in the past. Please select today or a future date.",
      );
      return;
    }

    if (offset === true) {
      // ============================================================
      // CHANGE 2: Floor changed from tomorrow -> today
      // Was: if (minInvoiceGenDate < tomorrow) minInvoiceGenDate = tomorrow
      // Now: if (minInvoiceGenDate < today)    minInvoiceGenDate = today
      // ============================================================
      let minInvoiceGenDate = new Date(startDate);
      minInvoiceGenDate.setDate(startNorm.getDate() - freqDays * 2);
      minInvoiceGenDate.setHours(0, 0, 0, 0);

      if (minInvoiceGenDate < today) {
        minInvoiceGenDate = new Date(today);
      }

      const maxInvoiceGenDate = new Date(startDate);
      maxInvoiceGenDate.setHours(0, 0, 0, 0);

      if (invGenNorm < minInvoiceGenDate) {
        showDateValidationError(
          "chargeInvoiceGenerationDate",
          `With Pre-Frequency Offset set to 'Yes', Invoice Generation Date must be on or after ${formatDateDisplay(minInvoiceGenDate)}.`,
        );
      } else if (invGenNorm > maxInvoiceGenDate) {
        showDateValidationError(
          "chargeInvoiceGenerationDate",
          `With Pre-Frequency Offset set to 'Yes', Invoice Generation Date cannot be after Start Date (${formatDateDisplay(maxInvoiceGenDate)}).`,
        );
      }
    } else {
      const minInvoiceGenDate = new Date(startDate);
      minInvoiceGenDate.setHours(0, 0, 0, 0);

      const maxInvoiceGenDate = new Date(startDate);
      maxInvoiceGenDate.setDate(startNorm.getDate() + freqDays * 2);
      maxInvoiceGenDate.setHours(0, 0, 0, 0);

      if (invGenNorm < minInvoiceGenDate) {
        showDateValidationError(
          "chargeInvoiceGenerationDate",
          `With Pre-Frequency Offset set to 'No', Invoice Generation Date must be on or after Start Date (${formatDateDisplay(startNorm)}).`,
        );
      } else if (invGenNorm > maxInvoiceGenDate) {
        showDateValidationError(
          "chargeInvoiceGenerationDate",
          `With Pre-Frequency Offset set to 'No' and ${getFrequencyName(frequency)} frequency, Invoice Generation Date must be on or before ${formatDateDisplay(maxInvoiceGenDate)} (Start Date + ${freqDays * 2} days).`,
        );
      }
    }
  }
}

// Show date validation error
function showDateValidationError(fieldId, message) {
  const field = document.getElementById(fieldId);
  if (!field) return;

  field.setCustomValidity(message);

  // Add visual error indicator
  field.style.borderColor = "#ef4444";
  field.style.boxShadow = "0 0 0 3px rgba(239, 68, 68, 0.1)";

  // Show tooltip-style error message
  const existingError = field.parentElement.querySelector(
    ".field-error-message",
  );
  if (existingError) {
    existingError.remove();
  }

  const errorDiv = document.createElement("div");
  errorDiv.className = "field-error-message";
  errorDiv.style.cssText = `
        color: #ef4444;
        font-size: 12px;
        margin-top: 4px;
        font-weight: 500;
    `;
  errorDiv.textContent = message;
  field.parentElement.appendChild(errorDiv);
}

// Clear all date validations
function clearDateValidations() {
  const dateFields = [
    "chargeStartDate",
    "chargeEndDate",
    "chargeInvoiceGenerationDate",
  ];

  dateFields.forEach((fieldId) => {
    const field = document.getElementById(fieldId);
    if (field) {
      field.setCustomValidity("");
      field.style.borderColor = "";
      field.style.boxShadow = "";

      // Remove error message
      const errorMsg = field.parentElement.querySelector(
        ".field-error-message",
      );
      if (errorMsg) {
        errorMsg.remove();
      }
    }
  });
}

//   Separate handler function for field changes
function handleFieldChangeForPreview(event) {
  const fieldId = event.target.id;

  // Mark as user modified
  event.target.setAttribute("data-user-modified", "true");

  // Update field state
  updateFieldState(event.target);

  // Special handling for specific fields
  if (fieldId === "chargeStartDate") {
    const prorationEnabled =
      document.getElementById("chargeProrationEnabled").value === "true";
    if (prorationEnabled) {
      autoPopulateFrequencyStartDate();
    }
  }

  if (fieldId === "chargeFrequency") {
    const prorationEnabled =
      document.getElementById("chargeProrationEnabled").value === "true";
    if (prorationEnabled) {
      autoPopulateFrequencyStartDate();
    }
    handleFrequencyVisibility();
  }

  if (fieldId === "chargeProrationEnabled") {
    handleProrationChange();
  }

  // Always update preview and validate
  validateAllDates();
  updateInvoiceDatePreview();

  console.log(` Field changed: ${fieldId} - Preview updated`);
}

// Auto-populate Due Date Rule with "As of the issue of the sales document"
function autoPopulateDueDateRule() {
  const dueDateRuleSelect = document.getElementById("chargeDueDateRule");
  if (!dueDateRuleSelect) return;

  if (!window.dueDateRules || window.dueDateRules.length === 0) {
    console.log("i No due date rules available for auto-populate");
    return;
  }

  // Try to find "as of the issue of the sales document" (case insensitive)
  const targetLabel = "as of the issue of the sales document";
  const matchingRule = window.dueDateRules.find((rule) => {
    const label =
      rule.Label && rule.Label.UserLocalizedLabel
        ? rule.Label.UserLocalizedLabel.Label
        : "";
    return label.toLowerCase().trim() === targetLabel;
  });

  if (matchingRule) {
    dueDateRuleSelect.value = matchingRule.Value;
    dueDateRuleSelect.setAttribute("data-user-input", "true");
    updateFieldState(dueDateRuleSelect);
    if (typeof handleDueDateRuleChange === "function")
      handleDueDateRuleChange();
    console.log(
      ` Due date rule auto-populated: "${matchingRule.Label?.UserLocalizedLabel?.Label}"`,
    );
  } else {
    // Fallback: select the first available rule
    const firstRule = window.dueDateRules[0];
    if (firstRule) {
      dueDateRuleSelect.value = firstRule.Value;
      dueDateRuleSelect.setAttribute("data-user-input", "true");
      updateFieldState(dueDateRuleSelect);
      if (typeof handleDueDateRuleChange === "function")
        handleDueDateRuleChange();
      console.log(
        `i Due date rule fallback to first option: "${firstRule.Label?.UserLocalizedLabel?.Label}"`,
      );
    }
  }
}

// Auto-populate Rate Rule with "Of the date of issue"
function autoPopulateRateRule() {
  if (!window.rateRules || window.rateRules.length === 0) {
    console.log("i No rate rules available");
    return;
  }

  const targetRuleNameLower = "of the date of issue";
  const matchingRule = window.rateRules.find(
    (rule) =>
      rule.array_rulename &&
      rule.array_rulename.toLowerCase().trim() === targetRuleNameLower,
  );

  if (matchingRule) {
    document.getElementById("chargeRateRule").value =
      matchingRule.array_exchangerateselectionrulesid;
    document.getElementById("chargeRateRuleDisplay").value =
      matchingRule.array_rulename;

    const display = document.getElementById("chargeRateRuleDisplay");
    display.setAttribute("data-user-input", "true");
    updateFieldState(display);

    const clearBtn = document.getElementById("clearRateRuleBtn");
    if (clearBtn) {
      clearBtn.style.display = "block";
    }

    // Check if Exchange Rate Day field should show for this rule name
    toggleExchangeRateDayField(matchingRule.array_rulename);

    console.log(` Rate rule auto-populated: "${matchingRule.array_rulename}"`);
  } else {
    console.log(
      `i Rate rule "Of the date of issue" not found in available rules`,
    );
    //  Hide Exchange Rate Day when no rule matched
    toggleExchangeRateDayField("");
  }
}

//  HANDLE CURRENCY CHANGE FOR BANK ACCOUNT
async function handleCurrencyChangeForBankAccount() {
  const currencySelect = document.getElementById("chargeCurrency");
  const selectedCurrencyId = currencySelect.value;

  if (!selectedCurrencyId || selectedCurrencyId.trim() === "") {
    lockBankAccountField();
    clearBankAccountField();
    const invoiceCurrencyGroup = document.getElementById(
      "useAsInvoiceCurrencyGroup",
    );
    if (invoiceCurrencyGroup) {
      invoiceCurrencyGroup.style.display = "none";
      const invoiceCurrencySelect = document.getElementById(
        "chargeUseAsInvoiceCurrency",
      );
      if (invoiceCurrencySelect) invoiceCurrencySelect.value = "false";
    }
    // Hide rate rule when no currency
    toggleRateRuleVisibility(false);
    return;
  }

  const selectedCurrencyObj = window.currencies
    ? window.currencies.find(
        (c) => c.transactioncurrencyid === selectedCurrencyId,
      )
    : null;
  const selectedCurrencyCode = selectedCurrencyObj
    ? (selectedCurrencyObj.isocurrencycode || "").toUpperCase()
    : "";
  const isPLN = selectedCurrencyCode === "PLN";

  const invoiceCurrencyGroup = document.getElementById(
    "useAsInvoiceCurrencyGroup",
  );
  if (invoiceCurrencyGroup) {
    if (!isPLN) {
      invoiceCurrencyGroup.style.display = "";
    } else {
      invoiceCurrencyGroup.style.display = "none";
      const invoiceCurrencySelect = document.getElementById(
        "chargeUseAsInvoiceCurrency",
      );
      if (invoiceCurrencySelect) invoiceCurrencySelect.value = "false";
    }
  }

  // Hide Rate Rule and Exchange Rate Day when PLN (default currency)
  toggleRateRuleVisibility(!isPLN);

  unlockBankAccountField();
  await autoPopulateBankAccountByCurrency(selectedCurrencyId);
}

function toggleRateRuleVisibility(show) {
  // Rate Rule field group
  const rateRuleDisplay = document.getElementById("chargeRateRuleDisplay");
  const rateRuleGroup = rateRuleDisplay
    ? rateRuleDisplay.closest(".form-group")
    : null;
  if (rateRuleGroup) {
    rateRuleGroup.style.display = show ? "" : "none";
  }

  // Exchange Rate Day field group
  const exchangeRateDayGroup = document.getElementById("exchangeRateDayGroup");
  if (exchangeRateDayGroup) {
    // Only show Exchange Rate Day if rate rule is visible AND the specific rule is selected
    if (!show) {
      exchangeRateDayGroup.style.display = "none";
    }
    // If show=true, toggleExchangeRateDayField handles visibility based on rule name
  }

  // Clear rate rule values when hiding
  if (!show) {
    const rateRuleHidden = document.getElementById("chargeRateRule");
    const rateRuleDisplayEl = document.getElementById("chargeRateRuleDisplay");
    const clearBtn = document.getElementById("clearRateRuleBtn");
    if (rateRuleHidden) rateRuleHidden.value = "";
    if (rateRuleDisplayEl) rateRuleDisplayEl.value = "";
    if (clearBtn) clearBtn.style.display = "none";
    const exchangeRateDayInput = document.getElementById(
      "chargeExchangeRateDay",
    );
    if (exchangeRateDayInput) exchangeRateDayInput.value = "";
  }
}

//  Show the "no bank account" toast at most once. Both the currency-change
//  auto-populate and the lookup-open detect the no-match case, which previously
//  stacked two identical toasts. Skip if the same message is already on screen.
function notifyNoBankAccount() {
  const msg = "There is no bank account for the selected currency";
  const alreadyShown = Array.from(
    document.querySelectorAll(".notification"),
  ).some((n) => n.textContent === msg);
  if (alreadyShown) return;
  showNotification(msg, "warning");
}

// AUTO-POPULATE BANK ACCOUNT BY CURRENCY
async function autoPopulateBankAccountByCurrency(currencyId) {
  if (!currencyId) {
    console.log("i No currency provided for bank account auto-population");
    return;
  }

  //  Restrict bank accounts to the property selected in Stage 1 (in addition to currency)
  const propertyId = document.getElementById("propertyId")?.value || "";

  try {
    console.log(
      ` Fetching bank accounts for currency: ${currencyId}${
        propertyId ? ` | property: ${propertyId}` : ""
      }`,
    );

    let filter = `statecode eq 0 and _array_currency_value eq ${currencyId}`;
    if (propertyId) {
      filter += ` and _array_property_value eq ${propertyId}`;
    }

    const results = await XrmContext.WebApi.retrieveMultipleRecords(
      "array_bankaccount",
      `?$select=array_bankaccountid,array_bankaccountnumber,_array_bankaccountname_value&$filter=${filter}&$orderby=createdon asc&$top=1`,
    );

    if (results.entities.length > 0) {
      const firstBankAccount = results.entities[0];

      document.getElementById("chargeBankAccount").value =
        firstBankAccount.array_bankaccountid;
      document.getElementById("chargeBankAccountDisplay").value =
        firstBankAccount.array_bankaccountnumber || "Bank Account";

      const display = document.getElementById("chargeBankAccountDisplay");
      display.setAttribute("data-user-input", "true");
      updateFieldState(display);

      const clearBtn = document.getElementById("clearBankAccountBtn");
      if (clearBtn) {
        clearBtn.style.display = "block";
      }

      console.log(
        ` Bank account auto-populated: ${firstBankAccount.array_bankaccountnumber}`,
      );
      // showNotification(" Bank account auto-selected", "success");
    } else {
      clearBankAccountField();
      console.log(
        `i No bank account found for currency: ${currencyId} in property: ${
          propertyId || "N/A"
        }`,
      );
      //  Notify: no bank account matched the selected property + currency
      notifyNoBankAccount();
    }
  } catch (error) {
    console.error(" Error auto-populating bank account:", error);
    clearBankAccountField();
  }
}

//  LOCK BANK ACCOUNT FIELD
function lockBankAccountField() {
  const bankAccountDisplay = document.getElementById(
    "chargeBankAccountDisplay",
  );
  const lookupBtn = bankAccountDisplay?.nextElementSibling;

  if (bankAccountDisplay) {
    bankAccountDisplay.disabled = true;
    bankAccountDisplay.style.cursor = "not-allowed";
    bankAccountDisplay.style.opacity = "0.6";
    bankAccountDisplay.style.backgroundColor = "#f3f4f6";
    bankAccountDisplay.placeholder = "Select currency first";
  }

  if (lookupBtn && lookupBtn.classList.contains("lookup-btn")) {
    lookupBtn.disabled = true;
    lookupBtn.style.cursor = "not-allowed";
    lookupBtn.style.opacity = "0.6";
    lookupBtn.style.pointerEvents = "none";
  }

  console.log(" Bank account field locked");
}

// UNLOCK BANK ACCOUNT FIELD
function unlockBankAccountField() {
  const bankAccountDisplay = document.getElementById(
    "chargeBankAccountDisplay",
  );
  const lookupBtn = bankAccountDisplay?.nextElementSibling;

  if (bankAccountDisplay) {
    bankAccountDisplay.disabled = false;
    bankAccountDisplay.style.cursor = "pointer";
    bankAccountDisplay.style.opacity = "1";
    bankAccountDisplay.style.backgroundColor = "";
    bankAccountDisplay.style.pointerEvents = "auto"; //  CRITICAL FIX
    bankAccountDisplay.placeholder = "Select bank account";
  }

  if (lookupBtn && lookupBtn.classList.contains("lookup-btn")) {
    lookupBtn.disabled = false;
    lookupBtn.style.cursor = "pointer";
    lookupBtn.style.opacity = "1";
    lookupBtn.style.pointerEvents = "";
  }

  console.log(" Bank account field unlocked");
}

//--------------------------------Stage 3.1 -----------------------BANK ACCOUNT LOOKUP FUNCTIONS --------------------------------------------------------//

// BANK ACCOUNT LOOKUP FUNCTIONS
function openBankAccountLookup() {
  // Check if currency is selected first
  const currencySelect = document.getElementById("chargeCurrency");
  const selectedCurrencyId = currencySelect?.value;

  if (!selectedCurrencyId || selectedCurrencyId.trim() === "") {
    showNotification(" Please select a currency first", "error");
    return;
  }

  const modal = document.getElementById("bankAccountLookupModal");
  modal.classList.add("active");
  document.body.style.overflow = "hidden";

  const searchBox = document.getElementById("bankAccountSearchBox");
  searchBox.value = "";

  const currentValue = document.getElementById("chargeBankAccount").value;
  const deselectBtn = document.getElementById("btnDeselectBankAccount");
  if (deselectBtn) {
    deselectBtn.style.display = currentValue ? "inline-flex" : "none";
  }

  setTimeout(() => {
    searchBox.focus();
  }, 100);

  // Load bank accounts filtered by selected currency
  loadBankAccountsByCurrency(selectedCurrencyId);
}

function loadBankAccounts(searchTerm = "") {
  const resultsContainer = document.getElementById("bankAccountSearchResults");
  resultsContainer.innerHTML = `
        <div style="min-height: 55vh; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; color: #667eea;">
            <div class="loader" style="margin: 0 auto 12px; width: 40px; height: 40px;"></div>
            <p style="font-size: 14px; color: #64748b;">Loading bank accounts...</p>
        </div>
    `;

  let filter = "statecode eq 0";
  if (searchTerm.trim().length > 0) {
    const escapedTerm = searchTerm.trim().replace(/'/g, "''");
    filter += ` and contains(array_bankaccountnumber,'${escapedTerm}')`;
  }

  XrmContext.WebApi.retrieveMultipleRecords(
    "array_bankaccount",
    `?$select=array_bankaccountid,array_bankaccountnumber,_array_bankaccountname_value&$filter=${filter}&$top=50&$orderby=array_bankaccountnumber asc`,
  ).then(
    function success(results) {
      if (results.entities.length === 0) {
        resultsContainer.innerHTML = `
                    <div style="text-align: center; padding: 40px 20px;">
                        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#cbd5e0" stroke-width="2" style="margin: 0 auto 16px; display: block;">
                            <rect x="1" y="4" width="22" height="16" rx="2" ry="2"/>
                            <line x1="1" y1="10" x2="23" y2="10"/>
                        </svg>
                        <p style="color: #718096; font-size: 15px; font-weight: 600; margin-bottom: 8px;">
                            No bank accounts found
                        </p>
                        ${
                          searchTerm
                            ? `
                            <p style="color: #a0aec0; font-size: 13px;">
                                No results for "<strong>${escapeHtml(
                                  searchTerm,
                                )}</strong>"
                            </p>
                        `
                            : `
                            <p style="color: #a0aec0; font-size: 13px;">
                                Type to search bank accounts
                            </p>
                        `
                        }
                    </div>
                `;
        return;
      }

      let html = `
                <div style="padding: 12px 16px; background: #f0f9ff; border-left: 4px solid #3b82f6; margin-bottom: 16px; border-radius: 6px;">
                    <p style="font-size: 13px; color: #1e40af; margin: 0; font-weight: 600;">
                        &#x1F4CB; ${results.entities.length} account${
                          results.entities.length !== 1 ? "s" : ""
                        } found
                    </p>
                </div>
                <div class="records-list">
            `;

      results.entities.forEach((account, index) => {
        const accountNumber = escapeHtml(
          account.array_bankaccountnumber || "N/A",
        );
        const bankName =
          account[
            "_array_bankaccountname_value@OData.Community.Display.V1.FormattedValue"
          ] || "Unknown Bank";
        const jsEscapedNumber = accountNumber
          .replace(/'/g, "\\'")
          .replace(/"/g, "&quot;");

        html += `
                    <div class="record-card" onclick="selectBankAccount('${
                      account.array_bankaccountid
                    }', '${jsEscapedNumber}')" 
                         style="cursor: pointer; transition: all 0.2s; border-left: 3px solid transparent; padding: 16px; ${
                           index % 2 === 0
                             ? "background: #f8fafc;"
                             : "background: white;"
                         }">
                        <div style="display: flex; align-items: center; gap: 12px;">
                            <div style="background: #dbeafe; width: 44px; height: 44px; border-radius: 8px; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2">
                                    <rect x="1" y="4" width="22" height="16" rx="2" ry="2"/>
                                    <line x1="1" y1="10" x2="23" y2="10"/>
                                </svg>
                            </div>
                            <div style="flex: 1; min-width: 0;">
                                <div style="font-size: 15px; font-weight: 700; color: #0f172a; margin-bottom: 4px;">
                                    ${accountNumber}
                                </div>
                                <div style="font-size: 13px; color: #64748b;">
                                    ${escapeHtml(bankName)}
                                </div>
                            </div>
                            <div style="color: #3b82f6; font-size: 18px;">></div>
                        </div>
                    </div>
                `;
      });

      html += "</div>";
      resultsContainer.innerHTML = html;
    },
    function error(err) {
      console.error("Error loading bank accounts:", err);
      resultsContainer.innerHTML = `
                <div style="text-align: center; padding: 40px 20px;">
                    <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" style="margin: 0 auto 16px; display: block;">
                        <circle cx="12" cy="12" r="10"/>
                        <line x1="12" y1="8" x2="12" y2="12"/>
                        <line x1="12" y1="16" x2="12.01" y2="16"/>
                    </svg>
                    <p style="color: #dc2626; font-size: 15px; font-weight: 600;">Error Loading</p>
                    <p style="color: #991b1b; font-size: 13px;">${escapeHtml(
                      err.message || "Unknown error",
                    )}</p>
                </div>
            `;
    },
  );
}

//  searchBankAccounts - Use currency filter
function searchBankAccounts() {
  const searchTerm = document.getElementById("bankAccountSearchBox").value;
  const currencySelect = document.getElementById("chargeCurrency");
  const selectedCurrencyId = currencySelect?.value;

  if (!selectedCurrencyId) {
    showNotification(" Please select a currency first", "error");
    closeModal("bankAccountLookupModal");
    return;
  }

  loadBankAccountsByCurrency(selectedCurrencyId, searchTerm);
}

function selectBankAccount(id, accountNumber) {
  document.getElementById("chargeBankAccount").value = id;
  document.getElementById("chargeBankAccountDisplay").value = accountNumber;

  const display = document.getElementById("chargeBankAccountDisplay");
  display.setAttribute("data-user-input", "true");
  updateFieldState(display);

  //  Show the clear button
  const clearBtn = document.getElementById("clearBankAccountBtn");
  if (clearBtn) {
    clearBtn.style.display = "flex";
  }

  closeModal("bankAccountLookupModal");
  showNotification(" Bank account selected", "success");
}

function deselectBankAccount() {
  clearBankAccountField();
  closeModal("bankAccountLookupModal");
  showNotification("Bank account deselected", "info");
}

//  Clear function for the x button in the field
function clearBankAccountField() {
  document.getElementById("chargeBankAccount").value = "";
  document.getElementById("chargeBankAccountDisplay").value = "";

  const display = document.getElementById("chargeBankAccountDisplay");
  display.removeAttribute("data-user-input");
  updateFieldState(display);

  // Hide the clear button
  const clearBtn = document.getElementById("clearBankAccountBtn");
  if (clearBtn) {
    clearBtn.style.display = "none";
  }
}

//  LOAD BANK ACCOUNTS BY CURRENCY
function loadBankAccountsByCurrency(currencyId, searchTerm = "") {
  const resultsContainer = document.getElementById("bankAccountSearchResults");
  resultsContainer.innerHTML = `
    <div style="min-height: 55vh; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; color: #667eea;">
        <div class="loader" style="margin: 0 auto 12px; width: 40px; height: 40px;"></div>
        <p style="font-size: 14px; color: #64748b;">Loading bank accounts...</p>
    </div>
  `;

  //  Filter by currency AND the property selected in Stage 1
  const propertyId = document.getElementById("propertyId")?.value || "";
  let filter = `statecode eq 0 and _array_currency_value eq ${currencyId}`;
  if (propertyId) {
    filter += ` and _array_property_value eq ${propertyId}`;
  }

  if (searchTerm.trim().length > 0) {
    const escapedTerm = searchTerm.trim().replace(/'/g, "''");
    filter += ` and contains(array_bankaccountnumber,'${escapedTerm}')`;
  }

  XrmContext.WebApi.retrieveMultipleRecords(
    "array_bankaccount",
    `?$select=array_bankaccountid,array_bankaccountnumber,_array_bankaccountname_value,_array_currency_value&$filter=${filter}&$top=50&$orderby=array_bankaccountnumber asc`,
  ).then(
    function success(results) {
      if (results.entities.length === 0) {
        const currencyName = getCurrencyName(currencyId);
        //  Toast on initial open only (avoid firing on every no-match keystroke)
        if (!searchTerm.trim()) {
          notifyNoBankAccount();
        }
        resultsContainer.innerHTML = `
          <div style="text-align: center; padding: 40px 20px;">
              <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#cbd5e0" stroke-width="2" style="margin: 0 auto 16px; display: block;">
                  <rect x="1" y="4" width="22" height="16" rx="2" ry="2"/>
                  <line x1="1" y1="10" x2="23" y2="10"/>
              </svg>
              <p style="color: #718096; font-size: 15px; font-weight: 600; margin-bottom: 8px;">
                  No bank accounts found
              </p>
              ${
                searchTerm
                  ? `
                  <p style="color: #a0aec0; font-size: 13px;">
                      No results for "<strong>${escapeHtml(
                        searchTerm,
                      )}</strong>" in ${currencyName}
                  </p>
              `
                  : `
                  <p style="color: #a0aec0; font-size: 13px;">
                      No bank accounts available for ${currencyName} in this property
                  </p>
              `
              }
          </div>
        `;
        return;
      }

      let html = `
        <div style="padding: 12px 16px; background: #f0f9ff; border-left: 4px solid #3b82f6; margin-bottom: 16px; border-radius: 6px;">
            <p style="font-size: 13px; color: #1e40af; margin: 0; font-weight: 600;">
                 ${results.entities.length} bank account${
                   results.entities.length !== 1 ? "s" : ""
                 } found
            </p>
        </div>
        <div class="records-list">
      `;

      results.entities.forEach((account, index) => {
        const accountNumber = escapeHtml(
          account.array_bankaccountnumber || "N/A",
        );
        const bankName =
          account[
            "_array_bankaccountname_value@OData.Community.Display.V1.FormattedValue"
          ] || "Unknown Bank";
        const jsEscapedNumber = accountNumber
          .replace(/'/g, "\\'")
          .replace(/"/g, "&quot;");

        html += `
  <div class="record-card" onclick="selectBankAccount('${
    account.array_bankaccountid
  }', '${jsEscapedNumber}')" 
       style="
         cursor: pointer; 
         transition: all 0.2s ease;
         border-left: 3px solid transparent; 
         padding: 16px; 
         margin-bottom: 8px;
         border-radius: 8px;
         min-height: 70px;
         display: flex;
         align-items: center;
         ${index % 2 === 0 ? "background: #f8fafc;" : "background: white;"}
       "
       onmouseover="this.style.background='#f0f9ff'; this.style.borderLeftColor='#3b82f6';"
       onmouseout="this.style.background='${
         index % 2 === 0 ? "#f8fafc" : "white"
       }'; this.style.borderLeftColor='transparent';">
      <div style="display: flex; align-items: center; gap: 12px; width: 100%;">
          <div style="background: #dbeafe; width: 44px; height: 44px; border-radius: 8px; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2">
                  <rect x="1" y="4" width="22" height="16" rx="2" ry="2"/>
                  <line x1="1" y1="10" x2="23" y2="10"/>
              </svg>
          </div>
          <div style="flex: 1; min-width: 0; overflow: hidden;">
              <div style="font-size: 15px; font-weight: 700; color: #0f172a; margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                  ${accountNumber}
              </div>
              ${
                bankName
                  ? `
                  <div style="font-size: 13px; color: #64748b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                      ${escapeHtml(bankName)}
                  </div>
              `
                  : ""
              }
          </div>
          <div style="color: #3b82f6; font-size: 18px; flex-shrink: 0;">></div>
      </div>
  </div>
`;
      });

      html += "</div>";
      resultsContainer.innerHTML = html;
    },
    function error(err) {
      console.error("Error loading bank accounts:", err);
      resultsContainer.innerHTML = `
        <div style="text-align: center; padding: 40px 20px;">
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" style="margin: 0 auto 16px; display: block;">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <p style="color: #dc2626; font-size: 15px; font-weight: 600;">Error Loading</p>
            <p style="color: #991b1b; font-size: 13px;">${escapeHtml(
              err.message || "Unknown error",
            )}</p>
        </div>
      `;
    },
  );
}

//  GET CURRENCY NAME BY ID
function getCurrencyName(currencyId) {
  if (!currencyId || !window.currencies) {
    return "selected currency";
  }

  const currency = window.currencies.find(
    (c) => c.transactioncurrencyid === currencyId,
  );
  return currency
    ? `${currency.currencyname} (${currency.isocurrencycode})`
    : "selected currency";
}

//--------------------------------------------------------------Stage 3.2------------------------ RATE RULE LOOKUP FUNCTIONS -------------------------------------------------//

// RATE RULE LOOKUP FUNCTIONS
function openRateRuleLookup() {
  const modal = document.getElementById("rateRuleLookupModal");
  modal.classList.add("active");
  document.body.style.overflow = "hidden";

  const searchBox = document.getElementById("rateRuleSearchBox");
  searchBox.value = "";

  // Show/hide deselect button based on current selection
  const currentValue = document.getElementById("chargeRateRule").value;
  const deselectBtn = document.getElementById("btnDeselectRateRule");
  if (deselectBtn) {
    deselectBtn.style.display = currentValue ? "inline-flex" : "none";
  }

  // Focus search box for immediate typing
  setTimeout(() => {
    searchBox.focus();
  }, 100);

  loadRateRules();
}

function searchRateRules() {
  const searchTerm = document.getElementById("rateRuleSearchBox").value;
  loadRateRules(searchTerm);
}

function selectRateRule(id, name) {
  document.getElementById("chargeRateRule").value = id;
  document.getElementById("chargeRateRuleDisplay").value = name;

  const display = document.getElementById("chargeRateRuleDisplay");
  display.setAttribute("data-user-input", "true");
  updateFieldState(display);

  //  Show the clear button
  const clearBtn = document.getElementById("clearRateRuleBtn");
  if (clearBtn) {
    clearBtn.style.display = "flex";
  }

  // Show/hide Exchange Rate Day based on selected rule name
  toggleExchangeRateDayField(name);

  closeModal("rateRuleLookupModal");
  showNotification(" Rate rule selected", "success");
}

function deselectRateRule() {
  clearRateRuleField();
  closeModal("rateRuleLookupModal");
  showNotification("Rate rule deselected", "info");
}

// Clear function for the x button in the field
function clearRateRuleField() {
  document.getElementById("chargeRateRule").value = "";
  document.getElementById("chargeRateRuleDisplay").value = "";

  const display = document.getElementById("chargeRateRuleDisplay");
  display.removeAttribute("data-user-input");
  updateFieldState(display);

  // Hide the clear button
  const clearBtn = document.getElementById("clearRateRuleBtn");
  if (clearBtn) {
    clearBtn.style.display = "none";
  }

  // Hide Exchange Rate Day when rule is cleared
  toggleExchangeRateDayField("");
}

// Toggle Exchange Rate Day field based on rule name
function toggleExchangeRateDayField(ruleName) {
  const group = document.getElementById("exchangeRateDayGroup");
  const input = document.getElementById("chargeExchangeRateDay");
  if (!group || !input) return;

  const lower = (ruleName || "").toLowerCase();
  const showDay =
    lower.includes("on a specific day of the month (or earlier)") ||
    lower.includes("on a specific day of the month (or later)");

  if (showDay) {
    group.style.display = "";
    input.setAttribute("required", "required");
  } else {
    group.style.display = "none";
    input.removeAttribute("required");
    input.value = "";
  }
}

// Handle Due Date Rule selection change
// function handleDueDateRuleChange() {
//   const select = document.getElementById("chargeDueDateRule");
//   if (select) {
//     select.setAttribute("data-user-input", "true");
//     updateFieldState(select);
//   }
// }
// Handle Due Date Rule selection change
function handleDueDateRuleChange() {
  const select = document.getElementById("chargeDueDateRule");
  if (select) {
    select.setAttribute("data-user-input", "true");
    updateFieldState(select);
  }

  // Rename "Due In (Days)" label based on selected rule
  const dueInDaysInput = document.getElementById("chargeDueInDays");
  if (dueInDaysInput && select) {
    const label = dueInDaysInput.closest(".form-group")?.querySelector("label");
    if (label) {
      const selectedText = (
        select.options[select.selectedIndex]?.text || ""
      ).toLowerCase();
      if (selectedText.includes("on a specific day of the month")) {
        label.textContent = "Specific Day";
      } else {
        label.textContent = "Due In (Days)";
      }
    }
  }

  //  Refresh fact card when due date rule changes
  updateInvoiceDatePreview();
}

//--------------------------------------------------------------------------STAGE 4 - DEPOSITS FUNCTIONS ----------------------------------------------------//

// Render Deposits in Stage
async function renderDeposits() {
  const container = document.getElementById("allDepositsContainer");

  if (!container) {
    console.warn("Deposits container not found");
    return;
  }

  // Load currencies if not already loaded
  if (!window.currencies || window.currencies.length === 0) {
    try {
      const currencies = await loadCurrencies();
      window.currencies = currencies;
      console.log(" Currencies loaded for deposits:", currencies.length);
    } catch (error) {
      console.error(" Error loading currencies:", error);
    }
  }

  if (deposits.length === 0) {
    container.innerHTML = `
            <div class="empty-state">
                <span class="empty-icon">&#x1F4B0;</span>
                <p>No records added yet</p>
                <p class="empty-hint">Click "Add" button above to create security & insurance records</p>
            </div>
        `;
    return;
  }

  const formatAmount = (amount) => {
    return amount.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
      useGrouping: true,
    });
  };

  const totalsByCurrency = {};
  deposits.forEach((d) => {
    if (!totalsByCurrency[d.currencyCode]) {
      totalsByCurrency[d.currencyCode] = { symbol: d.currencySymbol, total: 0 };
    }
    totalsByCurrency[d.currencyCode].total += d.amount;
  });

  const totalsHtml = Object.values(totalsByCurrency).length
    ? Object.values(totalsByCurrency)
        .map((c) => `${c.symbol}${formatAmount(c.total)}`)
        .join(" | ")
    : "-";

  let html = `
        <div class="deposits-table-wrapper">
            <table class="deposits-table">
                <thead>
                    <tr>
                        <th>Type</th>
                        <th>Guarantee no./Policy ID</th>
                        <th>Due date</th>
                        <th style="text-align:right;">Amount</th>
                        <th style="text-align:center;">Currency</th>
                        <th style="text-align:center;">Payments</th>
                        <th style="text-align:center;width:90px;">Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${deposits
                      .map((deposit) => {
                        const depositDataStr = JSON.stringify(deposit)
                          .replace(/'/g, "&#39;")
                          .replace(/"/g, "&quot;");
                        const isDeposit =
                          String(deposit.collateralType) ===
                          String(DEPOSIT_TYPE_VALUE);
                        return `
                        <tr>
                            <td style="font-weight:600;color:var(--text);">
                                ${escapeHtml(deposit.collateralTypeName || deposit.depositTypeName || "-")}
                                ${!deposit.collateralType ? '<span class="tag status-incomplete" style="margin-left:8px;">Select type</span>' : ""}
                            </td>
                            <td style="color:var(--sub);">${escapeHtml(deposit.guaranteeNo || "-")}</td>
                            <td style="color:var(--hint);">${deposit.dueDate ? formatDateDMY(deposit.dueDate) : "-"}</td>
                            <td style="text-align:right;font-weight:700;color:var(--blue);">${deposit.currencySymbol || ""}${deposit.amount.toFixed(2)}</td>
                            <td style="text-align:center;">${deposit.currencyName ? `<span class="tag tag-blue">${escapeHtml(deposit.currencyName)}</span>` : "-"}</td>
                            <td style="text-align:center;color:var(--sub);">${isDeposit && deposit.payments > 0 ? deposit.payments : "-"}</td>
                            <td style="text-align:center;white-space:nowrap;">
                                <span class="record-actions" style="justify-content:center;">
                                  <button class="action-edit" onclick='editDeposit(${depositDataStr})' title="Edit"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
                                  <button class="action-delete" onclick="deleteDeposit('${deposit.id}')" title="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg></button>
                                </span>
                            </td>
                        </tr>
                    `;
                      })
                      .join("")}
                </tbody>
            </table>
        </div>
        <div class="table-totals"><span>Total: <strong>${totalsHtml}</strong></span></div>
    `;

  container.innerHTML = html;
}

//open Deposit
async function openDepositModal(unitId = null, editDeposit = null) {
  const modal = document.getElementById("depositModal");
  modal.classList.add("active");
  document.body.style.overflow = "hidden";

  // -- Compute date constraints ---------------------------------------------
  const leaseStartDate = document.getElementById("startDate")?.value || "";
  const leaseEndDate = document.getElementById("endDate")?.value || "";

  const todayDate = new Date();
  todayDate.setHours(0, 0, 0, 0);
  const tomorrowDate = new Date(todayDate);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrowStr = formatDateForInput(tomorrowDate);

  // Apply min/max constraints to Start Date
  const depositStartDateEl = document.getElementById("depositStartDate");
  if (depositStartDateEl) {
    if (leaseStartDate) depositStartDateEl.min = leaseStartDate;
    if (leaseEndDate) depositStartDateEl.max = leaseEndDate;
  }

  // -- Helper: recalculate due date min based on deposit start date ----------
  // Rule:
  //   If deposit start date is today or in the future -> due date min = start date (inclusive)
  //   If deposit start date is in the past -> due date min = tomorrow
  //   If no deposit start date -> due date min = tomorrow
  // Note: due date may equal the start date (same-day due). Only a start date
  // that has already passed forces the due date to be after today. This keeps
  // autofilled records (where the document's due date == start date == today)
  // from being wiped when the modal opens.
  function _updateDepositDueDateMin(startVal) {
    const dueEl = document.getElementById("depositDueDate");
    if (!dueEl) return;

    const nowObj = new Date();
    nowObj.setHours(0, 0, 0, 0);
    const tmrStr = formatDateForInput(
      new Date(nowObj.getTime() + 24 * 60 * 60 * 1000),
    );

    let newMin;
    if (startVal) {
      const sObj = new Date(startVal);
      sObj.setHours(0, 0, 0, 0);
      // Today / future start date -> due can be same day as start (>= start date)
      // Past start date -> due must be after today
      newMin = sObj >= nowObj ? startVal : tmrStr;
    } else {
      newMin = tmrStr;
    }

    dueEl.min = newMin;
    if (leaseEndDate) dueEl.max = leaseEndDate;

    // Clear due date if it no longer satisfies the new minimum
    if (dueEl.value && dueEl.value < newMin) {
      dueEl.value = "";
      showNotification(
        "  Due Date was cleared as it no longer meets the date constraints",
        "warning",
      );
    }
  }

  // Wire up dynamic due date min - use onchange to avoid duplicate listeners
  if (depositStartDateEl) {
    depositStartDateEl.onchange = function () {
      _updateDepositDueDateMin(this.value);
    };
  }

  // Load currencies if not already loaded
  if (!window.currencies || window.currencies.length === 0) {
    try {
      const currencies = await loadCurrencies();
      window.currencies = currencies;
      console.log(" Currencies loaded:", currencies.length);
    } catch (error) {
      console.error(" Error loading currencies:", error);
      showNotification("Error loading currencies", "error");
    }
  }

  // Load collateral types and populate/lock the Type field
  if (!window.collateralTypes) {
    try {
      const ctypes = await loadCollateralTypes();
      window.collateralTypes = ctypes;
    } catch (err) {
      console.error("Error loading collateral types:", err);
      window.collateralTypes = [];
    }
  }
  populateCollateralType();

  // Populate tenant hidden fields from Stage 1
  const tenantId = document.getElementById("tenantId").value;
  const tenantType = document.getElementById("tenantType").value;
  document.getElementById("depositTenantId").value = tenantId || "";
  document.getElementById("depositTenantType").value = tenantType || "";

  // Populate currencies for all currency dropdowns
  const currencySelect = document.getElementById("depositCurrency");
  const currencySelectND = document.getElementById("depositCurrencyNonDeposit");
  const currencySelectDeliv = document.getElementById(
    "depositAmountDeliveredCurrency",
  );

  [currencySelect, currencySelectND, currencySelectDeliv].forEach((sel) => {
    if (sel) sel.innerHTML = '<option value="">Select currency</option>';
  });

  let defaultCurrencyId = null;

  if (window.currencies && window.currencies.length > 0) {
    window.currencies.forEach((currency) => {
      const val = currency.transactioncurrencyid;
      const text = `${currency.currencyname} (${currency.isocurrencycode})`;

      [currencySelect, currencySelectND, currencySelectDeliv].forEach((sel) => {
        if (!sel) return;
        const opt = document.createElement("option");
        opt.value = val;
        opt.textContent = text;
        sel.appendChild(opt);
      });

      if (parseFloat(currency.exchangerate) === 1.0) {
        defaultCurrencyId = val;
      }
    });
  }

  if (editDeposit) {
    // ===== EDIT MODE =====
    console.log(" Editing deposit:", editDeposit);
    document.getElementById("depositModalTitle").textContent =
      "Edit Security & Insurance";
    document.getElementById("btnSaveDepositText").textContent = "Update";
    document.getElementById("depositEditId").value = editDeposit.id;

    // Restore the Type (collateral type) from the record. populateCollateralType()
    // defaults the select to Deposit, so without this every edit shows "Deposit".
    // If the record has no resolved type (autofill couldn't match it), show a
    // placeholder so the user is forced to pick rather than silently saving Deposit.
    const collTypeSelect = document.getElementById("depositCollateralType");
    if (collTypeSelect) {
      const _hasType =
        editDeposit.collateralType != null && editDeposit.collateralType !== "";
      if (_hasType) {
        collTypeSelect.value = String(editDeposit.collateralType);
      } else if (!collTypeSelect.querySelector('option[value=""]')) {
        const _placeholder = document.createElement("option");
        _placeholder.value = "";
        _placeholder.textContent = "-- Select Type --";
        collTypeSelect.insertBefore(_placeholder, collTypeSelect.firstChild);
        collTypeSelect.value = "";
      } else {
        collTypeSelect.value = "";
      }
    }

    document.getElementById("depositAmount").value = editDeposit.amount || "";
    document.getElementById("depositPayments").value =
      editDeposit.payments || "";
    document.getElementById("depositDueDate").value = editDeposit.dueDate || "";

    // Start Date (set value first, then update due date min based on it)
    if (depositStartDateEl) {
      depositStartDateEl.value = editDeposit.startDate || "";
    }

    // Guarantee No / Policy ID
    const guaranteeNoEl = document.getElementById("depositGuaranteeNo");
    if (guaranteeNoEl) {
      guaranteeNoEl.value = editDeposit.guaranteeNo || "";
      updateFieldState(guaranteeNoEl);
    }

    // Currency (deposit)
    document.getElementById("depositCurrency").value =
      editDeposit.currencyId || "";
    if (editDeposit.currencyId) {
      currencySelect.setAttribute("data-user-input", "true");
    }

    // Currency (non-deposit)
    if (currencySelectND) currencySelectND.value = editDeposit.currencyId || "";

    // Non-deposit required amount
    const ndAmount = document.getElementById("depositAmountNonDeposit");
    if (ndAmount) ndAmount.value = editDeposit.amount || "";

    // Bank Name (always visible)
    const bankDisplay = document.getElementById("depositBankDisplay");
    const bankId = document.getElementById("depositBankId");
    const clearBankBtn = document.getElementById("clearDepositBankBtn");
    if (bankDisplay) bankDisplay.value = editDeposit.bankName || "";
    if (bankId) bankId.value = editDeposit.bankId || "";
    if (clearBankBtn)
      clearBankBtn.style.display = editDeposit.bankId ? "block" : "none";

    // Non-deposit extra fields
    const amtDeliv = document.getElementById("depositAmountDelivered");
    const amtDelivCcy = document.getElementById(
      "depositAmountDeliveredCurrency",
    );
    const issuerDisp = document.getElementById("depositIssuerDisplay");
    const issuerIdEl = document.getElementById("depositIssuerId");
    const clearIssuerBtn = document.getElementById("clearDepositIssuerBtn");
    const collApprEl = document.getElementById("depositCollateralApproved");
    if (amtDeliv) amtDeliv.value = editDeposit.amountDelivered || "";
    if (amtDelivCcy)
      amtDelivCcy.value = editDeposit.amountDeliveredCurrencyId || "";
    if (issuerDisp) {
      issuerDisp.value = editDeposit.issuerName || "";
      updateFieldState(issuerDisp);
    }
    if (issuerIdEl) issuerIdEl.value = editDeposit.issuerId || "";
    if (clearIssuerBtn)
      clearIssuerBtn.style.display = editDeposit.issuerId ? "block" : "none";
    if (collApprEl) collApprEl.value = editDeposit.collateralApproved || "";

    // Apply type-based visibility after populating collateral type
    const collTypeVal = document.getElementById("depositCollateralType").value;
    onDepositTypeChange(collTypeVal);

    // Apply due date min based on the loaded start date
    _updateDepositDueDateMin(
      depositStartDateEl ? depositStartDateEl.value : "",
    );
  } else {
    // ===== ADD MODE =====
    console.log("+ Adding new Security & Insurance record");
    document.getElementById("depositModalTitle").textContent =
      "Quick Create: Security & Insurance";
    document.getElementById("btnSaveDepositText").textContent = "Save";
    document.getElementById("depositEditId").value = "";
    document.getElementById("depositAmount").value = "";
    document.getElementById("depositPayments").value = "";
    document.getElementById("depositDueDate").value = "";

    //  AUTO-POPULATE start date from Stage 2 lease start date
    if (depositStartDateEl) {
      const leaseStartVal = document.getElementById("startDate")?.value || "";
      depositStartDateEl.value = leaseStartVal;
      if (leaseStartVal) {
        depositStartDateEl.setAttribute("data-user-input", "true");
        updateFieldState(depositStartDateEl);
      }
    }

    // Clear Guarantee No
    const guaranteeNoEl = document.getElementById("depositGuaranteeNo");
    if (guaranteeNoEl) {
      guaranteeNoEl.value = "";
      guaranteeNoEl.removeAttribute("data-user-input");
    }

    // Non-deposit amount
    const ndAmount = document.getElementById("depositAmountNonDeposit");
    if (ndAmount) ndAmount.value = "";

    // Set default currency (deposit)
    if (defaultCurrencyId) {
      currencySelect.value = defaultCurrencyId;
      currencySelect.setAttribute("data-user-input", "true");
      if (currencySelectND) currencySelectND.value = defaultCurrencyId;
    } else {
      currencySelect.value = "";
      if (currencySelectND) currencySelectND.value = "";
    }

    // Clear Bank Name (always visible)
    const bankDisplay = document.getElementById("depositBankDisplay");
    const bankId = document.getElementById("depositBankId");
    const clearBankBtn = document.getElementById("clearDepositBankBtn");
    if (bankDisplay) bankDisplay.value = "";
    if (bankId) bankId.value = "";
    if (clearBankBtn) clearBankBtn.style.display = "none";

    // Reset non-deposit extra fields
    const amtDelivAdd = document.getElementById("depositAmountDelivered");
    const amtDelivCcyAdd = document.getElementById(
      "depositAmountDeliveredCurrency",
    );
    const issuerDispAdd = document.getElementById("depositIssuerDisplay");
    const issuerIdAdd = document.getElementById("depositIssuerId");
    const clearIssuerBtnAdd = document.getElementById("clearDepositIssuerBtn");
    const collApprAdd = document.getElementById("depositCollateralApproved");
    if (amtDelivAdd) amtDelivAdd.value = "";
    if (amtDelivCcyAdd) amtDelivCcyAdd.value = "";
    if (issuerDispAdd) {
      issuerDispAdd.value = "";
      updateFieldState(issuerDispAdd);
    }
    if (issuerIdAdd) issuerIdAdd.value = "";
    if (clearIssuerBtnAdd) clearIssuerBtnAdd.style.display = "none";
    if (collApprAdd) collApprAdd.value = "false";

    // Apply initial due date min (no start date selected -> tomorrow)
    _updateDepositDueDateMin(
      depositStartDateEl ? depositStartDateEl.value : "",
    );
  }

  // Reset field states after a short delay
  setTimeout(() => {
    const modalInputs = modal.querySelectorAll(
      'input:not([type="hidden"]):not(.lookup-field), select, textarea',
    );
    modalInputs.forEach((input) => updateFieldState(input));
  }, 100);
}

// Toggle deposit modal field visibility based on selected type
const DEPOSIT_TYPE_VALUE = 126330007;

// True when the given collateral-type option value is a Notary deed
// (777 p.4/p.5 KPC). These carry no monetary value, so Required Amount is
// optional for them: the form drops the asterisk and saveDeposit skips the
// amount > 0 check.
function _isNotaryDeedCollateral(collateralValue) {
  if (collateralValue === "" || collateralValue == null) return false;
  const obj = (window.collateralTypes || []).find(
    (ct) => String(ct.Value) === String(collateralValue),
  );
  const label = (
    obj?.Label?.UserLocalizedLabel?.Label ||
    obj?.Label?.LocalizedLabels?.[0]?.Label ||
    ""
  ).toLowerCase();
  return label.includes("notary deed");
}

function onDepositTypeChange(selectedValue) {
  const isDeposit = String(selectedValue) === String(DEPOSIT_TYPE_VALUE);

  const depositOnlyFields = document.getElementById("depositOnlyFields");
  const nonDepositFields = document.getElementById("nonDepositFields");

  // Bank Name (array_account) - ALWAYS VISIBLE regardless of type
  // (already in DOM outside depositOnlyFields, no toggling needed)

  // Guarantee No - ALWAYS VISIBLE regardless of type
  // (already in DOM outside depositOnlyFields, no toggling needed)

  // Number of Payments - only for Deposit type
  const paymentsGroup = document.getElementById("depositPaymentsGroup");
  if (paymentsGroup) {
    paymentsGroup.style.display = isDeposit ? "" : "none";
    if (!isDeposit) {
      const paymentsInput = document.getElementById("depositPayments");
      if (paymentsInput) paymentsInput.value = "";
    }
  }

  if (isDeposit) {
    if (depositOnlyFields) depositOnlyFields.style.display = "";
    if (nonDepositFields) nonDepositFields.style.display = "none";
  } else {
    if (depositOnlyFields) depositOnlyFields.style.display = "none";
    if (nonDepositFields) nonDepositFields.style.display = "";

    // Required Amount is optional for Notary deed types - drop the asterisk.
    const _amtLabel = document.getElementById("depositAmountNonDepositLabel");
    if (_amtLabel) {
      _amtLabel.classList.toggle(
        "required",
        !_isNotaryDeedCollateral(selectedValue),
      );
    }

    // Auto-populate PLN as default currency for Amount Delivered Currency
    const amtDelivCcy = document.getElementById(
      "depositAmountDeliveredCurrency",
    );
    if (amtDelivCcy && !amtDelivCcy.value) {
      if (window.currencies && window.currencies.length > 0) {
        const plnCurrency = window.currencies.find(
          (c) => c.isocurrencycode && c.isocurrencycode.toUpperCase() === "PLN",
        );
        if (plnCurrency) {
          amtDelivCcy.value = plnCurrency.transactioncurrencyid;
          updateFieldState(amtDelivCcy);
        }
      }
    }

    // Sync Required Amount Currency to PLN if empty
    const reqAmtCcy = document.getElementById("depositCurrencyNonDeposit");
    if (reqAmtCcy && !reqAmtCcy.value) {
      if (window.currencies && window.currencies.length > 0) {
        const plnCurrency = window.currencies.find(
          (c) => c.isocurrencycode && c.isocurrencycode.toUpperCase() === "PLN",
        );
        if (plnCurrency) {
          reqAmtCcy.value = plnCurrency.transactioncurrencyid;
          updateFieldState(reqAmtCcy);
        }
      }
    }
  }

  // Suggestion box. A collateral configuration that links THIS type to a
  // calculation rule takes precedence (rule-driven, works for every type). When
  // none exists, fall back to the legacy hardcoded Deposit suggestion.
  const _ruleSuggestionShown = renderCollateralRuleSuggestion(selectedValue);
  const _legacyBox = document.getElementById("depositSuggestionBox");
  if (_ruleSuggestionShown) {
    if (_legacyBox) {
      _legacyBox.style.display = "none";
      _legacyBox.innerHTML = "";
    }
  } else if (isDeposit) {
    renderDepositSuggestionBox();
  } else if (_legacyBox) {
    _legacyBox.style.display = "none";
    _legacyBox.innerHTML = "";
  }
}

// Renders a closable suggestion box inside the deposit modal when a collateral
// CONFIGURATION links the selected collateral type to a calculation RULE. The
// rule's coefficient x the sum of its charge-type amounts (per currency) gives
// the minimum/suggested security amount. Returns true when a box was shown.
// ============================================================================
// AUTO-CREATE COLLATERAL RULE FROM MANUALLY-ADDED RECURRING CHARGES
// ----------------------------------------------------------------------------
// When the user builds recurring charges by hand (no AI autofill), seed a
// default collateral rule so they don't have to author it manually:
//   - coefficient 3 (Polish commercial market standard: ~3 months rent+SC)
//   - charge types = every distinct charge type currently on the lease
//   - one default configuration of type Deposit, linked to that rule
// Called after any change to `recurringCharges` (add / edit / delete).
//
// Guards:
//   * Never runs while an AI autofill is pending (that path owns creation).
//   * If NO rule exists yet -> create the default rule + Deposit config.
//   * If a rule ALREADY exists -> only keep its charge-type set in sync with
//     the charges (add missing types). Never changes a user-set coefficient,
//     never removes types the user added, never touches configs.
// The coefficient/config defaults live in constants so they are easy to change.
// ============================================================================
const AUTO_COLLATERAL_DEFAULT_COEFFICIENT = 3;
// Default collateral types the auto-created rule's configs cover.
// Deposit (126330007) + Bank Guarantee (126330000): both point to the same rule,
// so the required amount is identical whichever instrument the tenant posts.
const AUTO_COLLATERAL_DEFAULT_CONFIG_TYPES = [126330007, 126330000];

function autoCreateCollateralFromCharges() {
  // Don't fight the AI autofill path.
  if (window._pendingCollateralAutofill) return;

  // Distinct charge types from current charges (need a resolvable id).
  // Uses every distinct charge type on the lease.
  const seen = {};
  const distinct = [];
  (recurringCharges || []).forEach((ch) => {
    const id = ch.chargeType;
    if (!id || seen[id]) return;
    seen[id] = true;
    distinct.push({
      id:
        "ct_auto_" + String(id) + "_" + Math.random().toString(36).substr(2, 5),
      chargeTypeId: id,
      chargeTypeName: ch.chargeTypeName || "",
    });
  });

  if (distinct.length === 0) return; // nothing to base a rule on

  if (collateralRules.length === 0) {
    // --- Create the default rule ---
    const ruleId =
      "rule_auto_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5);
    collateralRules.push({
      id: ruleId,
      coefficient: AUTO_COLLATERAL_DEFAULT_COEFFICIENT,
      chargeTypes: distinct.map((ct) => ({ ...ct })),
      dataverseId: null,
      _auto: true,
    });

    // --- Create one default configuration per default type, linked to it ---
    AUTO_COLLATERAL_DEFAULT_CONFIG_TYPES.forEach((typeVal, ti) => {
      const already = collateralConfigs.some(
        (c) =>
          c.ruleId === ruleId && String(c.collateralType) === String(typeVal),
      );
      if (already) return;
      collateralConfigs.push({
        id:
          "cfg_auto_" +
          Date.now() +
          "_" +
          ti +
          "_" +
          Math.random().toString(36).substr(2, 5),
        dataverseId: null,
        ruleId: ruleId,
        ruleName: "Coefficient: " + AUTO_COLLATERAL_DEFAULT_COEFFICIENT,
        collateralType: typeVal,
        collateralTypeName: COLLATERAL_TYPE_LABELS[typeVal] || "Unknown",
        _auto: true,
      });
    });

    renderCollateralRules();
    renderCollateralConfigs();
    showNotification(
      "Collateral rule auto-created (coefficient " +
        AUTO_COLLATERAL_DEFAULT_COEFFICIENT +
        ", " +
        distinct.length +
        " charge type(s); Deposit + Bank Guarantee). Review before saving.",
      "info",
    );
    return;
  }

  // --- A rule already exists: only keep the auto rule's charge types in sync. ---
  // Sync only rules we created; leave user/AI-authored rules alone.
  let changed = false;
  collateralRules.forEach((rule) => {
    if (!rule._auto) return;
    const have = new Set(
      (rule.chargeTypes || []).map((ct) => String(ct.chargeTypeId)),
    );
    distinct.forEach((ct) => {
      if (!have.has(String(ct.chargeTypeId))) {
        rule.chargeTypes.push({ ...ct });
        changed = true;
      }
    });
  });
  if (changed) renderCollateralRules();
}

function renderCollateralRuleSuggestion(typeValue) {
  const box = document.getElementById("collateralRuleSuggestionBox");
  if (!box) return false;

  const _hide = () => {
    box.style.display = "none";
    box.innerHTML = "";
    return false;
  };

  if (typeValue === "" || typeValue == null) return _hide();

  const configs = (collateralConfigs || []).filter(
    (c) => String(c.collateralType) === String(typeValue),
  );
  if (configs.length === 0) return _hide();

  // Collect the rules referenced by the matching configuration(s).
  const rules = [];
  configs.forEach((cfg) => {
    const rule = (collateralRules || []).find((r) => r.id === cfg.ruleId);
    if (rule && !rules.includes(rule)) rules.push(rule);
  });
  if (rules.length === 0) return _hide();

  // Build per-currency suggested amounts across all referenced rules.
  const blocks = [];
  rules.forEach((rule) => {
    const ids = new Set(
      (rule.chargeTypes || []).map((ct) => String(ct.chargeTypeId)),
    );
    const names = new Set(
      (rule.chargeTypes || []).map((ct) =>
        (ct.chargeTypeName || "").toLowerCase(),
      ),
    );
    const byCcy = {};
    (recurringCharges || []).forEach((ch) => {
      const matches =
        ids.has(String(ch.chargeType)) ||
        names.has((ch.chargeTypeName || "").toLowerCase());
      if (!matches) return;
      const code = ch.currencyCode || "-";
      if (!byCcy[code])
        byCcy[code] = { symbol: ch.currencySymbol || "", base: 0 };
      byCcy[code].base += ch.amount || 0;
    });

    const coeff = rule.coefficient || 0;
    const chargeTypeLabels = (rule.chargeTypes || [])
      .map((ct) => escapeHtml(ct.chargeTypeName || ""))
      .filter(Boolean)
      .join(", ");

    const ccyRows = Object.entries(byCcy)
      .filter(([, d]) => d.base > 0)
      .map(([code, d]) => {
        const suggested = d.base * coeff;
        return `<div style="display:flex;justify-content:space-between;gap:12px;padding:4px 0;">
            <span style="color:var(--sub);font-size:12px;">${coeff} x ${d.symbol}${d.base.toFixed(2)} (${escapeHtml(code)})</span>
            <span style="font-weight:700;color:var(--blue-dk,#0D4A9E);font-size:13px;">${d.symbol}${suggested.toFixed(2)}</span>
          </div>`;
      })
      .join("");

    if (!ccyRows) {
      // Rule exists but no matching recurring charges yet - still inform the user.
      blocks.push(
        `<div style="margin-top:6px;">
          <div style="font-size:12px;color:var(--sub);">Coefficient ${coeff} on: ${chargeTypeLabels || "-"}</div>
          <div style="font-size:12px;color:var(--sub);font-style:italic;margin-top:2px;">Add the matching recurring charge(s) to compute a suggested amount.</div>
        </div>`,
      );
    } else {
      blocks.push(
        `<div style="margin-top:6px;">
          <div style="font-size:12px;color:var(--sub);margin-bottom:2px;">Coefficient ${coeff} on: ${chargeTypeLabels || "-"}</div>
          ${ccyRows}
        </div>`,
      );
    }
  });

  box.innerHTML = `
    <div style="position:relative;border:1px solid var(--blue-mid,#9DC3F0);background:var(--blue-l,#EBF3FF);border-radius:8px;padding:12px 36px 12px 14px;margin-bottom:16px;">
      <button type="button" onclick="dismissCollateralRuleSuggestion()" title="Dismiss"
        style="position:absolute;top:8px;right:8px;border:none;background:transparent;color:var(--sub);font-size:18px;line-height:1;cursor:pointer;">&times;</button>
      <div style="font-weight:700;color:var(--blue-dk,#0D4A9E);font-size:13px;margin-bottom:2px;">Suggested security amount</div>
      <div style="font-size:12px;color:var(--sub);">Based on the collateral calculation rule configured for this type.</div>
      ${blocks.join("")}
    </div>`;
  box.style.display = "";
  return true;
}

function dismissCollateralRuleSuggestion() {
  const box = document.getElementById("collateralRuleSuggestionBox");
  if (box) {
    box.style.display = "none";
    box.innerHTML = "";
  }
}

/**
 * renderDepositSuggestionBox
 * -----------------------------------------------------------------------------
 * Calculates the recommended deposit amount based on recurring charges of type
 * "RHAN - Rent - retail space" or "Service Charge", then shows the suggestion
 * inside #depositSuggestionBox.
 *
 * Rule  : Required deposit = (Rent total x 3) + (Service Charge total x 3)
 * Paid  : Sum of all existing deposits (collateralType = Deposit) already saved
 * Shown : Remaining = Required - Paid  (green "fully covered" if balance = 0)
 */
function renderDepositSuggestionBox() {
  const suggBox = document.getElementById("depositSuggestionBox");
  if (!suggBox) return;

  // -- 1. Identify qualifying charge type names (case-insensitive)
  function isRentCharge(name) {
    return (name || "").toLowerCase().includes("rhan - rent - retail space");
  }
  function isServiceCharge(name) {
    return (name || "").toLowerCase().includes("service charge");
  }

  // -- 2. Sum qualifying recurring charges, grouped by currencyCode
  const totalsByCurrency = {}; // { currencyCode: { symbol, rentTotal, scTotal } }

  (recurringCharges || []).forEach((charge) => {
    const name = charge.chargeTypeName || "";
    if (!isRentCharge(name) && !isServiceCharge(name)) return;

    const code = charge.currencyCode || "-";
    const symbol = charge.currencySymbol || "";
    if (!totalsByCurrency[code]) {
      totalsByCurrency[code] = { symbol, rentTotal: 0, scTotal: 0 };
    }
    if (isRentCharge(name)) {
      totalsByCurrency[code].rentTotal += charge.amount || 0;
    } else {
      totalsByCurrency[code].scTotal += charge.amount || 0;
    }
  });

  // -- 3. If no qualifying charges exist, hide and return
  if (Object.keys(totalsByCurrency).length === 0) {
    suggBox.style.display = "none";
    suggBox.innerHTML = "";
    return;
  }

  // -- 4. Sum existing deposits already saved, grouped by currencyCode
  const paidByCurrency = {}; // { currencyCode: number }
  (deposits || []).forEach((dep) => {
    if (String(dep.collateralType) !== String(DEPOSIT_TYPE_VALUE)) return;
    const code = dep.currencyCode || "-";
    paidByCurrency[code] = (paidByCurrency[code] || 0) + (dep.amount || 0);
  });

  // -- 5. Build the inner HTML
  const currencyBlocks = Object.entries(totalsByCurrency)
    .map(([code, data]) => {
      const { symbol, rentTotal, scTotal } = data;
      const required = rentTotal * 3 + scTotal * 3;
      const paid = paidByCurrency[code] || 0;
      const remaining = Math.max(0, required - paid);

      // Breakdown formula line
      const calcParts = [];
      if (rentTotal > 0)
        calcParts.push(`(Rent ${symbol}${rentTotal.toFixed(2)} x 3)`);
      if (scTotal > 0)
        calcParts.push(`(Service Charge ${symbol}${scTotal.toFixed(2)} x 3)`);
      const calcText = calcParts.join(" + ");

      // Paid badge - shown only when something has already been deposited
      const paidBadge =
        paid > 0
          ? `<span class="deposit-sugg-paid">Added: ${symbol}${paid.toFixed(2)}</span>`
          : "";

      // Remaining row - shown only when partially paid
      const remainingRow =
        remaining > 0 && paid > 0
          ? `<div class="deposit-sugg-line" style="margin-top:6px;">
           <div class="deposit-sugg-line-top">
             <span style="font-size:12px;color:var(--sub);">Remaining:&nbsp;</span>
             <strong style="color:var(--amber);">${symbol}${remaining.toFixed(2)} ${code}</strong>
           </div>
         </div>`
          : "";

      // Fully covered message
      const fullyCoveredRow =
        paid >= required && paid > 0
          ? `<div style="margin-top:6px;font-size:12px;color:var(--green);font-weight:600;"> Deposit fully covered</div>`
          : "";

      return `
      <div class="deposit-sugg-amounts">
        <div class="deposit-sugg-line">
          <div class="deposit-sugg-line-top">
            <strong style="font-size:15px;">${symbol}${required.toFixed(2)} ${code}</strong>
            ${paidBadge}
          </div>
          <div class="deposit-sugg-calc">${calcText}</div>
        </div>
        ${remainingRow}
        ${fullyCoveredRow}
      </div>`;
    })
    .join(
      "<hr style='border:none;border-top:1px solid var(--blue-mid);margin:10px 0;'>",
    );

  suggBox.innerHTML = `
    <span class="deposit-sugg-icon"></span>
    <div class="deposit-sugg-body">
      <div class="deposit-sugg-title">Suggested Required Deposit Amount</div>
      <div class="deposit-sugg-desc">
        Based on recurring charges (Rent + Service Charge), the recommended deposit is
        <strong>3x each charge total</strong>.
      </div>
      ${currencyBlocks}
    </div>`;

  suggBox.style.display = "flex";
}

// Save Depsoit
function saveDeposit() {
  console.log(" saveDeposit function called");

  const editId = document.getElementById("depositEditId").value;
  const collateralType = document.getElementById("depositCollateralType").value;
  const isDeposit = String(collateralType) === String(DEPOSIT_TYPE_VALUE);

  let amount = isDeposit
    ? parseFloat(document.getElementById("depositAmount").value)
    : parseFloat(
        (document.getElementById("depositAmountNonDeposit") || {}).value,
      );

  const currency = isDeposit
    ? document.getElementById("depositCurrency").value
    : (document.getElementById("depositCurrencyNonDeposit") || {}).value || "";

  const depositType = ""; // Sub Type field removed - value no longer collected
  const dueDate = document.getElementById("depositDueDate").value;
  const startDate = document.getElementById("depositStartDate")?.value || "";

  const payments = isDeposit
    ? parseInt(document.getElementById("depositPayments").value) || 0
    : 0;

  const guaranteeNo =
    (document.getElementById("depositGuaranteeNo") || {}).value || "";

  const tenantId = document.getElementById("depositTenantId").value;
  const tenantType = document.getElementById("depositTenantType").value;
  const tenantName = document.getElementById("tenantDisplay").value;

  const bankId = (document.getElementById("depositBankId") || {}).value || "";
  const bankName =
    (document.getElementById("depositBankDisplay") || {}).value || "";

  const _reqCcyEl = isDeposit
    ? document.getElementById("depositCurrency")
    : document.getElementById("depositCurrencyNonDeposit");
  const requiredAmountCurrencyId =
    _reqCcyEl && _reqCcyEl.offsetParent !== null && _reqCcyEl.value
      ? _reqCcyEl.value.trim()
      : "";

  const amountDelivered = !isDeposit
    ? parseFloat(
        (document.getElementById("depositAmountDelivered") || {}).value,
      ) || 0
    : 0;
  const amountDeliveredCurrencyId = !isDeposit
    ? (document.getElementById("depositAmountDeliveredCurrency") || {}).value ||
      ""
    : "";
  const issuerId = !isDeposit
    ? (document.getElementById("depositIssuerId") || {}).value || ""
    : "";
  const issuerName = !isDeposit
    ? (document.getElementById("depositIssuerDisplay") || {}).value || ""
    : "";
  const collateralApproved = !isDeposit
    ? (document.getElementById("depositCollateralApproved") || {}).value || ""
    : "";

  // -- Get Lease Dates from Stage 2 -----------------------------------------
  const leaseStartDate = document.getElementById("startDate")?.value || "";
  const leaseEndDate = document.getElementById("endDate")?.value || "";

  // -- Validation -----------------------------------------------------------
  if (!tenantId || !tenantName) {
    showNotification(" Tenant information is required", "error");
    return;
  }
  if (!collateralType) {
    showNotification(" Please select a Type", "error");
    return;
  }
  // Required Amount is optional for Notary deed (777 p.4/p.5 KPC) types - they
  // have no monetary value. A blank amount is normalized to 0. Every other type
  // still requires a positive amount.
  const _amountOptional = _isNotaryDeedCollateral(collateralType);
  if (_amountOptional) {
    if (isNaN(amount) || amount < 0) amount = 0;
  } else if (!amount || amount <= 0) {
    showNotification(" Please enter a valid required amount", "error");
    return;
  }
  if (!currency) {
    showNotification(" Please select a currency", "error");
    return;
  }

  // -- Start Date Validation ------------------------------------------------
  if (startDate) {
    const startDateObj = new Date(startDate);
    startDateObj.setHours(0, 0, 0, 0);

    if (leaseStartDate) {
      const leaseStartObj = new Date(leaseStartDate);
      leaseStartObj.setHours(0, 0, 0, 0);
      if (startDateObj < leaseStartObj) {
        showNotification(
          ` Start Date cannot be before the Lease Start Date (${formatDateDMY(leaseStartDate)})`,
          "error",
        );
        return;
      }
    }

    if (leaseEndDate) {
      const leaseEndObj = new Date(leaseEndDate);
      leaseEndObj.setHours(0, 0, 0, 0);
      if (startDateObj > leaseEndObj) {
        showNotification(
          ` Start Date cannot be after the Lease End Date (${formatDateDMY(leaseEndDate)})`,
          "error",
        );
        return;
      }
    }
  }

  // -- Due Date Validation ---------------------------------------------------
  if (dueDate) {
    const dueDateObj = new Date(dueDate);
    dueDateObj.setHours(0, 0, 0, 0);
    const todayObj = new Date();
    todayObj.setHours(0, 0, 0, 0);

    if (startDate) {
      const startDateObj = new Date(startDate);
      startDateObj.setHours(0, 0, 0, 0);

      if (startDateObj > todayObj) {
        // Start date is in the future: due date must be >= start date
        if (dueDateObj < startDateObj) {
          showNotification(
            ` Due Date must be on or after the Start Date (${formatDateDMY(startDate)})`,
            "error",
          );
          return;
        }
      } else {
        // Start date is today or past: due date must be strictly after today
        if (dueDateObj <= todayObj) {
          showNotification(
            " Due Date must be a future date (after today)",
            "error",
          );
          return;
        }
      }
    } else {
      // No start date: due date must be strictly after today
      if (dueDateObj <= todayObj) {
        showNotification(
          " Due Date must be a future date (after today)",
          "error",
        );
        return;
      }
    }

    // Must be on or after lease start date
    if (leaseStartDate) {
      const leaseStartObj = new Date(leaseStartDate);
      leaseStartObj.setHours(0, 0, 0, 0);
      if (dueDateObj < leaseStartObj) {
        showNotification(
          ` Due Date cannot be before the Lease Start Date (${formatDateDMY(leaseStartDate)})`,
          "error",
        );
        return;
      }
    }

    // Must be on or before lease end date (if lease end date exists)
    if (leaseEndDate) {
      const leaseEndObj = new Date(leaseEndDate);
      leaseEndObj.setHours(0, 0, 0, 0);
      if (dueDateObj > leaseEndObj) {
        showNotification(
          ` Due Date cannot be after the Lease End Date (${formatDateDMY(leaseEndDate)})`,
          "error",
        );
        return;
      }
    }
  }

  // -- Build display/save objects --------------------------------------------

  const depositTypeObj = window.depositTypes
    ? window.depositTypes.find((dt) => dt.Value === parseInt(depositType))
    : null;
  const depositTypeName =
    depositTypeObj?.Label?.UserLocalizedLabel?.Label || "";

  const collateralTypeObj = window.collateralTypes
    ? window.collateralTypes.find(
        (ct) => String(ct.Value) === String(collateralType),
      )
    : null;
  const collateralTypeName =
    collateralTypeObj?.Label?.UserLocalizedLabel?.Label ||
    collateralTypeObj?.Label?.LocalizedLabels?.[0]?.Label ||
    "";

  const currencyObj = window.currencies
    ? window.currencies.find((c) => c.transactioncurrencyid === currency)
    : null;
  const currencyName = currencyObj
    ? `${currencyObj.currencyname} (${currencyObj.isocurrencycode})`
    : "";
  const currencySymbol = currencyObj?.currencysymbol || "";
  const currencyCode = currencyObj?.isocurrencycode || "";

  if (editId) {
    const depositIndex = deposits.findIndex((d) => d.id === editId);
    if (depositIndex !== -1) {
      deposits[depositIndex] = {
        ...deposits[depositIndex],
        collateralType: parseInt(collateralType) || 126330007,
        collateralTypeName,
        depositType,
        depositTypeName,
        amount,
        payments,
        startDate: startDate || null,
        dueDate: dueDate || null,
        currencyId: currency,
        currencyName,
        currencySymbol,
        currencyCode,
        tenantId,
        tenantType,
        tenantName,
        unitId: null,
        unitName: "No Unit",
        bankId: bankId || null,
        bankName: bankName || "",
        guaranteeNo: guaranteeNo || "",
        requiredAmountCurrencyId: requiredAmountCurrencyId || null,
        amountDelivered: amountDelivered || 0,
        amountDeliveredCurrencyId: amountDeliveredCurrencyId || null,
        issuerId: issuerId || null,
        issuerName: issuerName || "",
        collateralApproved: collateralApproved || "",
      };
    }
  } else {
    const deposit = {
      id: "temp_" + Date.now(),
      collateralType: parseInt(collateralType) || 126330007,
      collateralTypeName,
      depositType,
      depositTypeName,
      amount,
      payments,
      startDate: startDate || null,
      dueDate: dueDate || null,
      currencyId: currency,
      currencyName,
      currencySymbol,
      currencyCode,
      tenantId,
      tenantType,
      tenantName,
      unitId: null,
      unitName: "No Unit",
      bankId: bankId || null,
      bankName: bankName || "",
      guaranteeNo: guaranteeNo || "",
      requiredAmountCurrencyId: requiredAmountCurrencyId || null,
      amountDelivered: amountDelivered || 0,
      amountDeliveredCurrencyId: amountDeliveredCurrencyId || null,
      issuerId: issuerId || null,
      issuerName: issuerName || "",
      collateralApproved: collateralApproved || "",
    };
    deposits.push(deposit);
  }

  closeModal("depositModal");
  renderDeposits();
  showNotification(" Record saved successfully", "success");
}

// Edit Deposit
function editDeposit(deposit) {
  openDepositModal(deposit.unitId, deposit);
}

// Delete Deposit
function deleteDeposit(id) {
  showDeleteConfirm(
    "Delete",
    "Are you sure you want to delete this record ?",
    () => {
      deposits = deposits.filter((d) => d.id !== id);
      renderDeposits();
      showNotification(" Record removed successfully", "success");
    },
  );
}

// -----------------------------------------------------------------------------
// DEPOSIT - BANK NAME LOOKUP (Account table)
// -----------------------------------------------------------------------------

/**
 * Opens the native Dynamics 365 lookup dialog scoped to the Account table.
 * Called when the user clicks the  icon on the Bank Name field in the deposit modal.
 */
function openDepositBankLookup() {
  if (!window.parent || !window.parent.Xrm) {
    console.error("[DepositBankLookup] Xrm context not available");
    showNotification("Xrm context not available", "error");
    return;
  }

  window.parent.Xrm.Utility.lookupObjects({
    entityTypes: ["account"],
    allowMultiSelect: false,
    defaultEntityType: "account",
    title: "Select Bank",
  })
    .then(function (result) {
      if (!result || result.length === 0) return;

      const selected = result[0];
      const cleanId = selected.id.replace(/[{}]/g, "");

      const bankDisplay = document.getElementById("depositBankDisplay");
      const bankId = document.getElementById("depositBankId");
      const clearBankBtn = document.getElementById("clearDepositBankBtn");

      if (bankDisplay) {
        bankDisplay.value = selected.name;
        updateFieldState(bankDisplay);
      }
      if (bankId) bankId.value = cleanId;
      if (clearBankBtn) clearBankBtn.style.display = "block";

      console.log("[DepositBankLookup] Bank selected:", selected.name);
    })
    .catch(function (error) {
      console.log("[DepositBankLookup] Dialog dismissed or error:", error);
    });
}

/**
 * Clears the Bank Name lookup field in the deposit modal.
 */
function clearDepositBankField() {
  const bankDisplay = document.getElementById("depositBankDisplay");
  const bankId = document.getElementById("depositBankId");
  const clearBankBtn = document.getElementById("clearDepositBankBtn");

  if (bankDisplay) {
    bankDisplay.value = "";
    updateFieldState(bankDisplay);
  }
  if (bankId) bankId.value = "";
  if (clearBankBtn) clearBankBtn.style.display = "none";
}

/**
 * Opens the Account lookup dialog for the Issuer field in the deposit modal.
 */
function openDepositIssuerLookup() {
  if (!window.parent || !window.parent.Xrm) {
    console.error("[DepositIssuerLookup] Xrm context not available");
    showNotification("Xrm context not available", "error");
    return;
  }

  window.parent.Xrm.Utility.lookupObjects({
    entityTypes: ["account"],
    allowMultiSelect: false,
    defaultEntityType: "account",
    title: "Select Issuer",
  })
    .then(function (result) {
      if (!result || result.length === 0) return;

      const selected = result[0];
      const cleanId = selected.id.replace(/[{}]/g, "");

      const issuerDisplay = document.getElementById("depositIssuerDisplay");
      const issuerId = document.getElementById("depositIssuerId");
      const clearIssuerBtn = document.getElementById("clearDepositIssuerBtn");

      if (issuerDisplay) {
        issuerDisplay.value = selected.name;
        updateFieldState(issuerDisplay);
      }
      if (issuerId) issuerId.value = cleanId;
      if (clearIssuerBtn) clearIssuerBtn.style.display = "block";

      console.log("[DepositIssuerLookup] Issuer selected:", selected.name);
    })
    .catch(function (error) {
      console.log("[DepositIssuerLookup] Dialog dismissed or error:", error);
    });
}

/**
 * Clears the Issuer lookup field in the deposit modal.
 */
function clearDepositIssuerField() {
  const issuerDisplay = document.getElementById("depositIssuerDisplay");
  const issuerId = document.getElementById("depositIssuerId");
  const clearIssuerBtn = document.getElementById("clearDepositIssuerBtn");

  if (issuerDisplay) {
    issuerDisplay.value = "";
    updateFieldState(issuerDisplay);
  }
  if (issuerId) issuerId.value = "";
  if (clearIssuerBtn) clearIssuerBtn.style.display = "none";
}

// -----------------------------------------------------------------------------

function syncDepositsWithTenant() {
  if (!Array.isArray(deposits) || deposits.length === 0) return;

  const tenantId = document.getElementById("tenantId").value;
  const tenantType = document.getElementById("tenantType").value;
  const tenantName = document.getElementById("tenantDisplay").value;

  deposits = deposits.map((d) => ({
    ...d,
    tenantId,
    tenantType,
    tenantName,
  }));

  console.log(" Existing deposits synced with updated tenant");
}

// Create deposits - returns Promise
function createDeposits(leaseAgreementId, tenantId, tenantType) {
  return new Promise((resolve) => {
    if (deposits.length === 0) {
      resolve();
      return;
    }

    let depositsCreated = 0;
    const depositsToCreate = deposits.length;

    deposits.forEach(function (deposit) {
      const depositRecord = {};

      depositRecord.array_type = deposit.collateralType || 126330007;

      const isDeposit =
        String(deposit.collateralType) === String(DEPOSIT_TYPE_VALUE);

      depositRecord.array_requiredamount = deposit.amount;

      const isValidGuid = (id) =>
        typeof id === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          id.trim(),
        );

      // Required Amount Currency
      const reqCcyId = deposit.requiredAmountCurrencyId || "";
      if (isValidGuid(reqCcyId)) {
        depositRecord["array_RequiredAmountCurrency@odata.bind"] =
          `/transactioncurrencies(${reqCcyId.trim()})`;
      }

      // Start Date
      if (deposit.startDate && deposit.startDate.trim() !== "") {
        depositRecord.array_startdate = deposit.startDate;
      }

      // Due Date
      if (deposit.dueDate && deposit.dueDate.trim() !== "") {
        depositRecord.array_duedate = deposit.dueDate;
      }

      // Number of Payments - only for Deposit type
      if (isDeposit && deposit.payments && deposit.payments > 0) {
        depositRecord.array_numberofpayments = deposit.payments;
      }

      // Guarantee No / Policy ID
      if (deposit.guaranteeNo && deposit.guaranteeNo.trim() !== "") {
        depositRecord.array_guaranteeno = deposit.guaranteeNo.trim();
      }

      // Bank Name
      if (deposit.bankId && deposit.bankId.trim() !== "") {
        depositRecord["array_Account@odata.bind"] =
          `/accounts(${deposit.bankId})`;
      }

      // Lease Agreement
      const isValidLeaseGuidDeposit = isValidGuid(leaseAgreementId);
      if (isValidLeaseGuidDeposit) {
        depositRecord["array_LeaseAgreement@odata.bind"] =
          `/array_leaseagreements(${leaseAgreementId.trim()})`;
      }

      //  Tenant lookup - save tenant on deposit
      const depTenantId = deposit.tenantId || tenantId;
      const depTenantType = deposit.tenantType || tenantType;
      if (depTenantId && depTenantType) {
        if (depTenantType === "account") {
          depositRecord["array_Tenant_account@odata.bind"] =
            `/accounts(${depTenantId})`;
        } else if (depTenantType === "contact") {
          depositRecord["array_Tenant_contact@odata.bind"] =
            `/contacts(${depTenantId})`;
        }
      }

      // Non-deposit only fields
      if (!isDeposit) {
        if (deposit.amountDelivered && deposit.amountDelivered > 0) {
          depositRecord.array_amountdelivered = deposit.amountDelivered;
        }
        if (
          deposit.amountDeliveredCurrencyId &&
          isValidGuid(deposit.amountDeliveredCurrencyId)
        ) {
          depositRecord["array_AmountDeliveredCurrency@odata.bind"] =
            `/transactioncurrencies(${deposit.amountDeliveredCurrencyId})`;
        }
        if (deposit.issuerId && deposit.issuerId.trim() !== "") {
          depositRecord["array_Issuer@odata.bind"] =
            `/accounts(${deposit.issuerId})`;
        }
        if (
          deposit.collateralApproved !== "" &&
          deposit.collateralApproved !== null &&
          deposit.collateralApproved !== undefined
        ) {
          depositRecord.array_collateralapproved = parseInt(
            deposit.collateralApproved,
          );
        }
      }

      console.log(
        " [Deposit payload]:",
        JSON.parse(JSON.stringify(depositRecord)),
      );

      XrmContext.WebApi.createRecord("array_deposit", depositRecord).then(
        function success(result) {
          depositsCreated++;
          console.log(` Deposit created (ID: ${result.id})`);
          if (depositsCreated === depositsToCreate) resolve();
        },
        function error(depositError) {
          console.error(` Error creating deposit:`, depositError);
          depositsCreated++;
          if (depositsCreated === depositsToCreate) resolve();
        },
      );
    });
  });
}

//--------------------------------------------------------------------------------STAGE 5 - REVIEW/PREVIEW FUNCTIONS --------------------------------------------------//

// Preview - Generate Review Page Content
function updatePreviewContent() {
  const leaseTypeSelect = document.getElementById("leaseType");
  const leaseTermTypeSelect = document.getElementById("leaseTermType");
  const selectedLeaseType =
    leaseTypeSelect.options[leaseTypeSelect.selectedIndex];
  const selectedLeaseTermType =
    leaseTermTypeSelect.options[leaseTermTypeSelect.selectedIndex];

  const leaseTypeText = selectedLeaseType ? selectedLeaseType.textContent : "-";
  const leaseTermTypeText = selectedLeaseTermType
    ? selectedLeaseTermType.textContent
    : "-";

  // -- Ready-to-activate hero KPIs (presentation only) ---------------------
  const _setText = (id, txt) => {
    const el = document.getElementById(id);
    if (el) el.textContent = txt;
  };

  const leaseTermValue = document.getElementById("leaseTerm").value;

  const _leaseName = document.getElementById("leaseName").value || "Lease";
  const _tenantName = document.getElementById("tenantDisplay").value || "-";
  _setText("preview-bannerSub", `${_leaseName} - ${_tenantName}`);

  // Lease term
  _setText(
    "preview-kpiTerm",
    leaseTermValue ? `${leaseTermValue} months` : "-",
  );
  _setText(
    "preview-kpiTermSub",
    [leaseTermTypeText, leaseTypeText]
      .filter((t) => t && t !== "-")
      .join(" - ") || "-",
  );

  // Total area - sum the selected units, but fall back to the canonical
  // total (manually entered for Month-to-Month leases with no unit selected).
  const _unitsArea = (units || []).reduce(
    (sum, u) => sum + (parseFloat(u.area) || 0),
    0,
  );
  const _totalArea = _unitsArea || parseFloat(totalUnitsAreaValue) || 0;
  _setText("preview-kpiArea", _totalArea ? `${_totalArea} m2` : "-");
  const _unitNames = (units || []).map((u) => u.name).filter(Boolean);
  _setText(
    "preview-kpiAreaSub",
    units.length
      ? `${units.length} unit${units.length !== 1 ? "s" : ""}${_unitNames.length ? " - " + _unitNames.slice(0, 2).join(" + ") : ""}`
      : "No units",
  );

  // Group amounts by currency -> [mainDisplay, secondaryDisplay]
  const _byCurrency = (rows) => {
    const totals = {};
    (rows || []).forEach((r) => {
      const code = r.currencyCode || "";
      if (!totals[code])
        totals[code] = { symbol: r.currencySymbol || "", total: 0 };
      totals[code].total += r.amount || 0;
    });
    const parts = Object.values(totals)
      .filter((t) => t.total)
      .map((t) => `${t.symbol}${Math.round(t.total).toLocaleString()}`);
    return [
      parts[0] || "-",
      parts
        .slice(1)
        .map((p) => "+ " + p)
        .join("  "),
    ];
  };

  const [_monMain, _monSub] = _byCurrency(recurringCharges);
  _setText("preview-kpiMonthly", _monMain);
  _setText("preview-kpiMonthlySub", _monSub);

  const [_secMain, _secSub] = _byCurrency(deposits);
  _setText("preview-kpiSecurity", _secMain);
  _setText("preview-kpiSecuritySub", _secSub);

  // ===== CONSOLIDATED LEASE INFORMATION SECTION =====
  // Compact 2-up label-above-value grid (kept per user request - the mock's
  // full-width rows wasted space here). Rest of review follows the mock.
  const _rf = (label, value, full) =>
    `<div class="review-field${full ? " full" : ""}"><span class="rf-label">${label}</span><span class="rf-value" title="${escapeHtml(value)}">${escapeHtml(value)}</span></div>`;

  const _descVal = document.getElementById("description").value;
  const leaseInfoHTML = `
  <div class="review-section-card" style="--acc:#1C6BD4;--accL:#EBF3FF;">
    <div class="review-section-header">
      <div class="review-section-header-left">
        <div class="review-section-icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="16" x2="12" y2="12"/>
            <line x1="12" y1="8" x2="12.01" y2="8"/>
          </svg>
        </div>
        <h3 class="review-section-header-title">Lease Agreement Information</h3>
      </div>
    </div>
    <div class="review-grid">
      ${_rf("Lease Name", document.getElementById("leaseName").value || "-")}
      ${_rf("Lease Type", leaseTypeText)}
      ${_rf("Lease Term Type", leaseTermTypeText)}
      ${_rf("Lease Term", leaseTermValue ? leaseTermValue + " months" : "-")}
      ${_rf("Tenant", document.getElementById("tenantDisplay").value || "-")}
      ${_rf("Property", document.getElementById("propertyDisplay").value || "-")}
      ${_rf("Brand Name", document.getElementById("brandNameDisplay") && document.getElementById("brandNameDisplay").value ? document.getElementById("brandNameDisplay").value : "-")}
      ${_rf("Primary Contact", document.getElementById("contactDisplay").value || "-")}
      ${_rf("Property Manager", document.getElementById("propertyManagerDisplay").value || "-")}
      ${_rf("Start Date", document.getElementById("startDate").value ? formatDateDMY(document.getElementById("startDate").value) : "-")}
      ${_rf("End Date", document.getElementById("endDate").value ? formatDateDMY(document.getElementById("endDate").value) : "-")}
      ${_rf("Move-in Date", document.getElementById("moveInDate") && document.getElementById("moveInDate").value ? formatDateDMY(document.getElementById("moveInDate").value) : "-")}
      ${_descVal ? _rf("Description", _descVal, true) : ""}
    </div>
  </div>
`;

  // ===== UNITS TABLE SECTION =====
  let unitsHTML = `
    <div class="review-section-card" style="--acc:#2E9494;--accL:#E6F6F6;">
      <div class="review-section-header">
        <div class="review-section-header-left">
          <div class="review-section-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>
              <polyline points="9 22 9 12 15 12 15 22"/>
            </svg>
          </div>
          <h3 class="review-section-header-title">Units</h3>
        </div>
        <span class="review-section-badge">${units.length} ${units.length === 1 ? "Unit" : "Units"}</span>
      </div>
      <div class="review-section-body">
  `;

  if (units.length === 0) {
    unitsHTML += `
      <div class="review-empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin: 0 auto 12px; opacity: 0.3;">
          <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>
          <polyline points="9 22 9 12 15 12 15 22"/>
        </svg>
        <p>No units have been added</p>
      </div>
    `;
  } else {
    unitsHTML += `
      <table class="review-charges-table">
        <thead>
          <tr>
            <th>Unit Name</th>
            <th>Type</th>
            <th>Floor</th>
            <th>Area (sq m)</th>
            <th style="text-align: right;">Market Rent</th>
            <th style="text-align: center;">Action</th>
          </tr>
        </thead>
        <tbody>
    `;
    units.forEach((unit) => {
      const unitDataStr = JSON.stringify(unit)
        .replace(/'/g, "&#39;")
        .replace(/"/g, "&quot;");
      unitsHTML += `
        <tr>
          <td><strong>${escapeHtml(unit.name)}</strong></td>
          <td>${escapeHtml(unit.type)}</td>
          <td>${escapeHtml(unit.floor)}</td>
          <td>${unit.area}</td>
          <td style="text-align: right; font-weight: 700; color: var(--text);">${unit.marketRent ? "EUR " + unit.marketRent.toFixed(2) : "-"}</td>
          <td style="text-align: center;">
            <button class="btn-view-details" onclick='viewUnitDetails(${unitDataStr})' title="View Details">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                <circle cx="12" cy="12" r="3"/>
              </svg>
              View Details
            </button>
          </td>
        </tr>
      `;
    });
    unitsHTML += `</tbody></table>`;
  }
  unitsHTML += `</div></div>`;

  // ===== RECURRING CHARGES TABLE SECTION =====
  let chargesHTML = `
<div class="review-section-card" style="--acc:#B0801F;--accL:#FBF1D8;">
  <div class="review-section-header">
    <div class="review-section-header-left">
      <div class="review-section-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/>
          <rect x="9" y="3" width="6" height="4" rx="1"/>
          <path d="M9 12h6M9 16h4"/>
        </svg>
      </div>
      <h3 class="review-section-header-title">Recurring Charges</h3>
    </div>
    <span class="review-section-badge">
      ${recurringCharges.length} ${recurringCharges.length === 1 ? "Charge" : "Charges"}
    </span>
  </div>
  <div class="review-section-body">
`;

  if (recurringCharges.length === 0) {
    chargesHTML += `
    <div class="review-empty-state">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin: 0 auto 12px; opacity: 0.3;">
        <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/>
        <rect x="9" y="3" width="6" height="4" rx="1"/>
        <path d="M9 12h6M9 16h4"/>
      </svg>
      <p>No recurring charges have been added</p>
    </div>
  `;
  } else {
    chargesHTML += `
    <table class="review-charges-table">
      <thead>
        <tr>
          <th>Unit Name</th>
          <th>Charge Name</th>
          <th>Type</th>
          <th style="text-align: center;">Frequency</th>
          <th style="text-align: right;">Amount</th>
          <th style="text-align: center;">Action</th>
        </tr>
      </thead>
      <tbody>
  `;
    recurringCharges.forEach((charge) => {
      const chargeDataStr = JSON.stringify(charge)
        .replace(/'/g, "&#39;")
        .replace(/"/g, "&quot;");
      chargesHTML += `
      <tr>
        <td><strong>${escapeHtml(charge.unitName || "-")}</strong></td>
        <td>${escapeHtml(charge.name)}</td>
        <td>${escapeHtml(charge.chargeTypeName || "-")}</td>
        <td style="text-align: center;">
          <span style="background: #f1f5f9; color: #475569; padding: 5px 12px; border-radius: 6px; font-size: 12px; font-weight: 600; display: inline-block;">
            ${escapeHtml(charge.frequencyName || "-")}
          </span>
        </td>
        <td style="text-align: right; font-weight: 700; color: var(--text);">
          ${charge.currencySymbol || ""}${charge.amount.toFixed(2)}
        </td>
        <td style="text-align: center;">
          <button class="btn-view-details" onclick='viewChargeDetails(${chargeDataStr})' title="View Details">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
            View Details
          </button>
        </td>
      </tr>
    `;
    });

    const totalsByCurrency = {};
    recurringCharges.forEach((c) => {
      if (!totalsByCurrency[c.currencyCode]) {
        totalsByCurrency[c.currencyCode] = {
          symbol: c.currencySymbol || "",
          total: 0,
        };
      }
      totalsByCurrency[c.currencyCode].total += c.amount;
    });
    const chargeTotalsHtml = Object.values(totalsByCurrency)
      .map((t) => `${t.symbol}${t.total.toFixed(2)}`)
      .join(" | ");

    chargesHTML += `
      </tbody>
      <tfoot>
        <tr>
          <td colspan="4"><strong>Total Charges</strong></td>
          <td style="text-align: right; font-weight: 800; color: var(--text); white-space: nowrap;">
            ${chargeTotalsHtml}
          </td>
          <td></td>
        </tr>
      </tfoot>
    </table>
  `;
  }
  chargesHTML += `</div></div>`;

  // ===== SECURITY & INSURANCE TABLE SECTION (single block) =====
  let depositsHTML = `
<div class="review-section-card" style="--acc:#D9605C;--accL:#FCEAEA;">
  <div class="review-section-header">
    <div class="review-section-header-left">
      <div class="review-section-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
        </svg>
      </div>
      <h3 class="review-section-header-title">Security & Insurance</h3>
    </div>
    <span class="review-section-badge">
      ${deposits.length} ${deposits.length === 1 ? "Record" : "Records"}
    </span>
  </div>
  <div class="review-section-body">
`;

  if (deposits.length === 0) {
    depositsHTML += `
    <div class="review-empty-state">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin: 0 auto 12px; opacity: 0.3;">
        <rect x="1" y="4" width="22" height="16" rx="2" ry="2"/>
        <line x1="1" y1="10" x2="23" y2="10"/>
      </svg>
      <p>No security & insurance records have been added</p>
    </div>
  `;
  } else {
    depositsHTML += `
    <table class="review-deposits-table">
      <thead>
        <tr>
          <th>Type</th>
          <th>Guarantee No/Policy ID</th>
          <th>Due Date</th>
          <th style="text-align: right;">Amount</th>
          <th style="text-align: center;">Currency</th>
          <th style="text-align: center;">Action</th>
        </tr>
      </thead>
      <tbody>
    `;

    deposits.forEach((deposit) => {
      const depositDataStr = JSON.stringify(deposit)
        .replace(/'/g, "&#39;")
        .replace(/"/g, "&quot;");
      depositsHTML += `
          <tr>
            <td>${escapeHtml(deposit.collateralTypeName || deposit.depositTypeName || "-")}</td>
            <td style="font-size: 13px; color: #64748b;">${escapeHtml(deposit.guaranteeNo || "-")}</td>
            <td>
              <span style="font-size: 12px; font-weight: 600; color: #334155;">
                ${deposit.dueDate ? formatDateDMY(deposit.dueDate) : "-"}
              </span>
            </td>
            <td style="text-align: right; font-weight: 700; color: var(--text);">
              <strong>${deposit.currencySymbol || ""}${deposit.amount.toFixed(2)}</strong>
            </td>
            <td style="text-align: center;">
              <span style="background: #f0fdf4; color: #166534; padding: 5px 12px; border-radius: 6px; font-size: 12px; font-weight: 600; display: inline-block;">
                ${escapeHtml(deposit.currencyName || deposit.currencyCode || "-")}
              </span>
            </td>
            <td style="text-align: center;">
              <button class="btn-view-details" onclick='viewDepositDetails(${depositDataStr})' title="View Details">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                  <circle cx="12" cy="12" r="3"/>
                </svg>
                View Details
              </button>
            </td>
          </tr>
        `;
    });

    const depositTotalsByCurrency = {};
    deposits.forEach((d) => {
      const key = d.currencyCode || d.currencySymbol || "UNKNOWN";
      if (!depositTotalsByCurrency[key]) {
        depositTotalsByCurrency[key] = {
          symbol: d.currencySymbol || "",
          total: 0,
        };
      }
      depositTotalsByCurrency[key].total += d.amount;
    });
    const depositTotalsHtml = Object.values(depositTotalsByCurrency)
      .map((c) => `${c.symbol}${c.total.toFixed(2)}`)
      .join(" | ");

    depositsHTML += `
      </tbody>
      <tfoot>
        <tr>
          <td colspan="3"><strong>Total Amount</strong></td>
          <td style="text-align: right; font-weight: 800;">
            ${depositTotalsHtml || "-"}
          </td>
          <td colspan="2"></td>
        </tr>
      </tfoot>
    </table>
  `;
  }

  depositsHTML += `</div></div>`;

  // ===== LEASE OPTIONS TABLE SECTION (Stage 5) =====
  const sessionOptions = window.sessionLeaseOptions || [];
  let optionsHTML = `
<div class="review-section-card" style="--acc:#8257D1;--accL:#F1ECFB;">
  <div class="review-section-header">
    <div class="review-section-header-left">
      <div class="review-section-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/>
          <rect x="9" y="3" width="6" height="4" rx="1"/>
          <path d="M9 12h6M9 16h4"/>
        </svg>
      </div>
      <h3 class="review-section-header-title">Lease Options</h3>
    </div>
    <span class="review-section-badge">
      ${sessionOptions.length} ${sessionOptions.length === 1 ? "Option" : "Options"}
    </span>
  </div>
  <div class="review-section-body">
`;

  if (sessionOptions.length === 0) {
    optionsHTML += `
    <div class="review-empty-state">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin: 0 auto 12px; opacity: 0.3;">
        <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/>
        <rect x="9" y="3" width="6" height="4" rx="1"/>
      </svg>
      <p>No lease options have been added</p>
    </div>
  `;
  } else {
    optionsHTML += `
    <table class="review-charges-table">
      <thead>
        <tr>
          <th>Option Type</th>
          <th>Option Holder</th>
          <th>Available From</th>
          <th>Expiry Date</th>
          <th>Notice Deadline</th>
          <th style="text-align: center;">Action</th>
        </tr>
      </thead>
      <tbody>
    `;
    sessionOptions.forEach((opt) => {
      const optDataStr = JSON.stringify(opt)
        .replace(/'/g, "&#39;")
        .replace(/"/g, "&quot;");
      optionsHTML += `
        <tr>
          <td><strong>${escapeHtml(opt.optionTypeName || opt.optionType || "-")}</strong></td>
          <td>${escapeHtml(opt.optionHolderName || opt.optionHolder || "-")}</td>
          <td>${opt.executionDate ? formatDateDMY(opt.executionDate) : "-"}</td>
          <td>${opt.expirationDate ? formatDateDMY(opt.expirationDate) : "-"}</td>
          <td>${opt.noticeDate ? formatDateDMY(opt.noticeDate) : "-"}</td>
          <td style="text-align: center;">
            <button class="btn-view-details" onclick='viewOptionDetails(${optDataStr})' title="View Details">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                <circle cx="12" cy="12" r="3"/>
              </svg>
              View Details
            </button>
          </td>
        </tr>
      `;
    });
    optionsHTML += `</tbody></table>`;
  }
  optionsHTML += `</div></div>`;

  // ===== LEASE CLAUSES SECTION (Stage 6) =====
  const sessionClauses = window.sessionLeaseClauses || [];
  let clausesHTML = `
<div class="review-section-card" style="--acc:#52A356;--accL:#E7F6E8;">
  <div class="review-section-header">
    <div class="review-section-header-left">
      <div class="review-section-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/>
          <polyline points="17 6 23 6 23 12"/>
        </svg>
      </div>
      <h3 class="review-section-header-title">Financial Clauses</h3>
    </div>
    <span class="review-section-badge">
      ${sessionClauses.length} ${sessionClauses.length === 1 ? "Clause" : "Clauses"}
    </span>
  </div>
  <div class="review-section-body">
`;

  if (sessionClauses.length === 0) {
    clausesHTML += `
    <div class="review-empty-state">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin: 0 auto 12px; opacity: 0.3;">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
      </svg>
      <p>No Financial Clauses have been configured</p>
    </div>
  `;
  } else {
    clausesHTML += `
    <table class="review-charges-table">
      <thead>
        <tr>
          <th>Clause Type</th>
          <th>Effective Date</th>
          <th>Expiry Date</th>
          <th>Summary</th>
          <th style="text-align: center;">Action</th>
        </tr>
      </thead>
      <tbody>
    `;
    sessionClauses.forEach((clause) => {
      const instances =
        clause.stepRentInstances ||
        clause.cpiInstances ||
        clause.turnoverInstances;
      if (instances && instances.length > 0) {
        instances.forEach((inst, idx) => {
          const description =
            inst.clauseSummary || inst.description || clause.description || "-";
          const clauseDataStr = JSON.stringify(clause)
            .replace(/'/g, "&#39;")
            .replace(/"/g, "&quot;");
          clausesHTML += `
            <tr>
              <td>
                <strong>${escapeHtml(clause.clauseType || "-")}</strong>
                <span style="font-size:11px;color:#6b7280;margin-left:6px;">Instance ${idx + 1}</span>
              </td>
              <td>${inst.effectiveDate || clause.effectiveDate ? formatDateDMY(inst.effectiveDate || clause.effectiveDate) : "-"}</td>
              <td>${inst.expiryDate || clause.expiryDate ? formatDateDMY(inst.expiryDate || clause.expiryDate) : "-"}</td>
              <td style="color:#6b7280;font-size:13px;">${escapeHtml(description)}</td>
              <td style="text-align: center;">
                <button class="btn-view-details" onclick='viewClauseDetails(${clauseDataStr}, ${idx})' title="View Details">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                    <circle cx="12" cy="12" r="3"/>
                  </svg>
                  View Details
                </button>
              </td>
            </tr>
          `;
        });
      } else {
        const clauseDataStr = JSON.stringify(clause)
          .replace(/'/g, "&#39;")
          .replace(/"/g, "&quot;");
        clausesHTML += `
          <tr>
            <td><strong>${escapeHtml(clause.clauseType || "-")}</strong></td>
            <td>${clause.effectiveDate ? formatDateDMY(clause.effectiveDate) : "-"}</td>
            <td>${clause.expiryDate ? formatDateDMY(clause.expiryDate) : "-"}</td>
            <td style="color:#6b7280;font-size:13px;">${escapeHtml(clause.description || "-")}</td>
            <td style="text-align: center;">
              <button class="btn-view-details" onclick='viewClauseDetails(${clauseDataStr}, 0)' title="View Details">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                  <circle cx="12" cy="12" r="3"/>
                </svg>
                View Details
              </button>
            </td>
          </tr>
        `;
      }
    });
    clausesHTML += `</tbody></table>`;
  }
  clausesHTML += `</div></div>`;

  // Combine all sections
  const container = document.getElementById("previewUnitsWithDetails");
  container.innerHTML =
    leaseInfoHTML +
    unitsHTML +
    chargesHTML +
    depositsHTML +
    optionsHTML +
    clausesHTML;
}

// 1. VIEW UNIT DETAILS FUNCTION - Form-like Layout
function viewUnitDetails(unit) {
  const modalHTML = `
    <div class="modal active" id="viewUnitModal" style="z-index: 100000;">
      <div class="modal-content" style="max-width: 800px; border-radius: 16px; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);">
        <div class="modal-header" style="padding: 20px 32px;">
          <h3 class="modal-title" style="color: white; font-size: 18px; display: flex; align-items: center; gap: 12px; font-weight: 500;">
            <span>Unit Details</span>
          </h3>
          <button class="modal-close" onclick="closeViewModal('viewUnitModal')">x</button>
        </div>
        <div class="modal-body" style="max-height: 70vh; overflow-y: auto; padding: 0; background: #f5f5f5;">
          
          <!-- BASIC INFORMATION SECTION -->
          <div style="background: white; margin: 0; padding: 24px 32px; border-bottom: 3px solid #f5f5f5;">
            <div style="padding-left: 0; margin-bottom: 24px;">
              <h4 style="color: var(--blue); font-size: 13px; font-weight: 700; letter-spacing: 0.5px; margin: 0;">BASIC INFORMATION</h4>
            </div>
            <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px;">
              <div>
                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">UNIT NAME</div>
                <div style="color: #2c3e50; font-size: 15px; font-weight: 600;">${escapeHtml(
                  unit.name,
                )}</div>
              </div>
              <div>
                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">UNIT ID</div>
                <div style="color: #2c3e50; font-size: 15px; font-weight: 600;">${escapeHtml(
                  unit.recordId || "N/A",
                )}</div>
              </div>
              <div>
                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">PROPERTY</div>
                <div style="color: #2c3e50; font-size: 15px; font-weight: 600;">${escapeHtml(
                  unit.property || "-",
                )}</div>
              </div>
              <div>
                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">BUILDING</div>
                <div style="color: #2c3e50; font-size: 15px; font-weight: 600;">${escapeHtml(
                  unit.building || "-",
                )}</div>
              </div>
              <div>
                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">FLOOR</div>
                <div style="color: #2c3e50; font-size: 15px; font-weight: 600;">${escapeHtml(
                  unit.floor,
                )}</div>
              </div>
              <div>
                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">TYPE</div>
                <div style="color: #2c3e50; font-size: 15px; font-weight: 600;">${escapeHtml(
                  unit.type,
                )}</div>
              </div>
              ${
                unit.subtype
                  ? `
              <div>
                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">SUBTYPE</div>
                <div style="color: #2c3e50; font-size: 15px; font-weight: 600;">${escapeHtml(
                  unit.subtype,
                )}</div>
              </div>
              `
                  : ""
              }
            </div>
          </div>

          <!-- SPECIFICATIONS SECTION -->
          <div style="background: white; margin: 0; padding: 24px 32px; border-bottom: 3px solid #f5f5f5;">
            <div style="padding-left: 0; margin-bottom: 24px;">
              <h4 style="color: var(--blue); font-size: 13px; font-weight: 700; letter-spacing: 0.5px; margin: 0;">SPECIFICATIONS</h4>
            </div>
            <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px;">
              <div>
                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">AREA</div>
                <div style="color: #2c3e50; font-size: 15px; font-weight: 600;">${
                  unit.area
                } sq m</div>
              </div>
              ${
                unit.totalRooms
                  ? `
              <div>
                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">TOTAL ROOMS</div>
                <div style="color: #2c3e50; font-size: 15px; font-weight: 600;">${unit.totalRooms}</div>
              </div>
              `
                  : ""
              }
              ${
                unit.bedrooms
                  ? `
              <div>
                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">BEDROOMS</div>
                <div style="color: #2c3e50; font-size: 15px; font-weight: 600;">${unit.bedrooms}</div>
              </div>
              `
                  : ""
              }
              ${
                unit.bathrooms
                  ? `
              <div>
                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">BATHROOMS</div>
                <div style="color: #2c3e50; font-size: 15px; font-weight: 600;">${unit.bathrooms}</div>
              </div>
              `
                  : ""
              }
            </div>
          </div>

          <!-- FINANCIAL DETAILS SECTION -->
          <div style="background: white; margin: 0; padding: 24px 32px;">
            <div style="padding-left: 0; margin-bottom: 24px;">
              <h4 style="color: var(--blue); font-size: 13px; font-weight: 700; letter-spacing: 0.5px; margin: 0;">FINANCIAL DETAILS</h4>
            </div>
            <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px;">
              ${
                unit.coldRent
                  ? `
              <div>
                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">COLD RENT</div>
                <div style="color: #2c3e50; font-size: 16px; font-weight: 700;">EUR ${unit.coldRent.toFixed(
                  2,
                )}</div>
              </div>
              `
                  : ""
              }
              ${
                unit.warmRent
                  ? `
              <div>
                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">WARM RENT</div>
                <div style="color: #2c3e50; font-size: 16px; font-weight: 700;">EUR ${unit.warmRent.toFixed(
                  2,
                )}</div>
              </div>
              `
                  : ""
              }
              ${
                unit.marketRent
                  ? `
              <div>
                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">MARKET RENT</div>
                <div style="color: #2c3e50; font-size: 16px; font-weight: 700;">EUR ${unit.marketRent.toFixed(
                  2,
                )}</div>
              </div>
              `
                  : ""
              }
              ${
                unit.securityDeposit
                  ? `
              <div>
                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">SECURITY DEPOSIT</div>
                <div style="color: #2c3e50; font-size: 16px; font-weight: 700;">EUR ${unit.securityDeposit.toFixed(
                  2,
                )}</div>
              </div>
              `
                  : ""
              }
            </div>
          </div>
        </div>
        <div class="modal-footer" style="background: #f5f5f5; padding: 16px 32px; border-top: 1px solid #e0e0e0;">
          <button class="btn btn-secondary" onclick="closeViewModal('viewUnitModal')" style="padding: 10px 24px; background: #ef4444; border: none; color: white; font-weight: 600;">
            Close
          </button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML("beforeend", modalHTML);
  document.body.style.overflow = "hidden";
}

// 2. VIEW CHARGE DETAILS FUNCTION - Complete with All Fields
function viewChargeDetails(charge) {
  const modalHTML = `
    <div class="modal active" id="viewChargeModal" style="z-index: 100000;">
      <div class="modal-content" style="max-width: 800px; border-radius: 16px; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);">
        
        <div class="modal-header" style="padding: 20px 32px;">
          <h3 class="modal-title" style="color: white; font-size: 18px; display: flex; align-items: center; gap: 12px; font-weight: 500;">
            <span>Charge Details</span>
          </h3>
          <button class="modal-close" onclick="closeViewModal('viewChargeModal')">x</button>
        </div>

        <div class="modal-body" style="max-height: 70vh; overflow-y: auto; padding: 0; background: #f5f5f5;">

          <!-- LINKING INFORMATION SECTION -->
          <div style="background: white; margin: 0; padding: 24px 32px; border-bottom: 3px solid #f5f5f5;">
            <div style="padding-left: 0; margin-bottom: 24px;">
              <h4 style="color: var(--blue); font-size: 13px; font-weight: 700; letter-spacing: 0.5px; margin: 0;">LINKING INFORMATION</h4>
            </div>
            <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px;">
              
              <div>
                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">CHARGE NAME</div>
                <div style="color: #2c3e50; font-size: 15px; font-weight: 600;">${escapeHtml(charge.name)}</div>
              </div>

              <div>
                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">UNIT</div>
                <div style="color: #2c3e50; font-size: 15px; font-weight: 600;">${escapeHtml(charge.unitName || "-")}</div>
              </div>

              <div>
                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">CHARGE TYPE</div>
                <div style="color: #2c3e50; font-size: 15px; font-weight: 600;">${escapeHtml(charge.chargeTypeName || "-")}</div>
              </div>

              <div>
                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">START DATE</div>
                <div style="color: #2c3e50; font-size: 15px; font-weight: 600;">${charge.startDate ? formatDateDMY(charge.startDate) : "-"}</div>
              </div>

              <div>
                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">END DATE</div>
                <div style="color: #2c3e50; font-size: 15px; font-weight: 600;">${charge.endDate ? formatDateDMY(charge.endDate) : "-"}</div>
              </div>

              <div>
                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">FREQUENCY</div>
                <div style="color: #2c3e50; font-size: 15px; font-weight: 600;">${escapeHtml(charge.frequencyName || "-")}</div>
              </div>
            </div>
          </div>

          <!-- CHARGE INFORMATION SECTION -->
          <div style="background: white; margin: 0; padding: 24px 32px; border-bottom: 3px solid #f5f5f5;">
            <div style="padding-left: 0; margin-bottom: 24px;">
              <h4 style="color: var(--blue); font-size: 13px; font-weight: 700; letter-spacing: 0.5px; margin: 0;">CHARGE INFORMATION</h4>
            </div>
            <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px;">
              
              <div>
                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">AMOUNT</div>
                <div style="color: #2c3e50; font-size: 16px; font-weight: 700;">${charge.currencySymbol || ""}${charge.amount.toFixed(2)}</div>
              </div>

              <div>
                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">CURRENCY</div>
                <div style="color: #2c3e50; font-size: 15px; font-weight: 600;">${escapeHtml(charge.currencyName || "-")}</div>
              </div>

              ${
                charge.vatName
                  ? `
              <div>
                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">VAT</div>
                <div style="color: #2c3e50; font-size: 15px; font-weight: 600;">${escapeHtml(charge.vatName)}</div>
              </div>`
                  : ""
              }

              <div>
                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">TAX INCLUDED</div>
                <div style="color: #2c3e50; font-size: 15px; font-weight: 600;">${charge.taxIncluded ? "Yes" : "No"}</div>
              </div>

              <div>
                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">BILLABLE AREA</div>
                <div style="color: #2c3e50; font-size: 15px; font-weight: 600;">${charge.billableArea ? charge.billableArea + " sq m" : "-"}</div>
              </div>

              <div>
                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">INVOICE SEPARATELY</div>
                <div style="color: #2c3e50; font-size: 15px; font-weight: 600;">${charge.invoiceSeparately ? "Yes" : "No"}</div>
              </div>
            </div>
          </div>

          <!-- BILLING DETAILS SECTION -->
          <div style="background: white; margin: 0; padding: 24px 32px; border-bottom: 3px solid #f5f5f5;">
            <div style="padding-left: 0; margin-bottom: 24px;">
              <h4 style="color: var(--blue); font-size: 13px; font-weight: 700; letter-spacing: 0.5px; margin: 0;">BILLING DETAILS</h4>
            </div>
            <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px;">

              ${
                charge.invoiceGenerationDate
                  ? `
              <div>
                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">INVOICE GENERATION DATE</div>
                <div style="color: #2c3e50; font-size: 15px; font-weight: 600;">${formatDateDMY(charge.invoiceGenerationDate)}</div>
              </div>`
                  : ""
              }

              <div>
                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">DUE IN (DAYS)</div>
                <div style="color: #2c3e50; font-size: 15px; font-weight: 600;">${charge.dueInDays !== undefined && charge.dueInDays !== "" ? charge.dueInDays : "-"}</div>
              </div>

              <div>
                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">PRORATION ENABLED</div>
                <div style="color: #2c3e50; font-size: 15px; font-weight: 600;">${charge.prorationEnabled ? "Yes" : "No"}</div>
              </div>

              <div>
                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">PRE-FREQUENCY OFFSET</div>
                <div style="color: #2c3e50; font-size: 15px; font-weight: 600;">${charge.preFrequencyOffset ? "Yes" : "No"}</div>
              </div>

              ${
                charge.bankAccountName
                  ? `
              <div>
                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">BANK ACCOUNT</div>
                <div style="color: #2c3e50; font-size: 15px; font-weight: 600;">${escapeHtml(charge.bankAccountName)}</div>
              </div>`
                  : ""
              }

              ${
                charge.rateRuleName
                  ? `
              <div>
                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">RATE RULE</div>
                <div style="color: #2c3e50; font-size: 15px; font-weight: 600;">${escapeHtml(charge.rateRuleName)}</div>
              </div>`
                  : ""
              }

              ${
                charge.invoicePrefixName
                  ? `
              <div>
                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">INVOICE PREFIX</div>
                <div style="color: #2c3e50; font-size: 15px; font-weight: 600;">${escapeHtml(charge.invoicePrefixName)}</div>
              </div>`
                  : ""
              }
            </div>
          </div>

        </div>

        <div class="modal-footer" style="background: #f5f5f5; padding: 16px 32px; border-top: 1px solid #e0e0e0;">
          <button class="btn btn-secondary" onclick="closeViewModal('viewChargeModal')" style="padding: 10px 24px; background: #ef4444; border: none; color: white; font-weight: 600;">
            Close
          </button>
        </div>

      </div>
    </div>
  `;

  document.body.insertAdjacentHTML("beforeend", modalHTML);
  document.body.style.overflow = "hidden";
}

// 3. VIEW DEPOSIT DETAILS FUNCTION
function viewDepositDetails(deposit) {
  const modalHTML = `
        <div class="modal active" id="viewDepositModal" style="z-index: 100000;">
            <div class="modal-content" style="max-width: 800px; border-radius: 16px; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);">
                <div class="modal-header" style="padding: 20px 32px;">
                    <h3 class="modal-title" style="color: white; font-size: 18px; display: flex; align-items: center; gap: 12px; font-weight: 500;">
                        <span>Security & Insurance Details</span>
                    </h3>
                    <button class="modal-close" onclick="closeViewModal('viewDepositModal')">x</button>
                </div>
                <div class="modal-body" style="padding: 0; background: #f5f5f5;">

                    <div style="background: white; margin: 0; padding: 24px 32px;">
                        <div style="padding-left: 0; margin-bottom: 24px;">
                            <h4 style="color: var(--blue); font-size: 13px; font-weight: 700; letter-spacing: 0.5px; margin: 0;">INFORMATION</h4>
                        </div>
                        <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px;">

                            <div>
                                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">TENANT</div>
                                <div style="color: #2c3e50; font-size: 15px; font-weight: 600;">${escapeHtml(deposit.tenantName)}</div>
                            </div>

                            <div>
                                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">TYPE</div>
                                <div style="color: #2c3e50; font-size: 15px; font-weight: 600;">
                                    ${escapeHtml(deposit.collateralTypeName || deposit.depositTypeName || "-")}
                                </div>
                            </div>

                            <div>
                                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">BANK</div>
                                <div style="color: #2c3e50; font-size: 15px; font-weight: 600;">${escapeHtml(deposit.bankName || "-")}</div>
                            </div>

                            <div>
                                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">GUARANTEE NO/POLICY ID</div>
                                <div style="color: #2c3e50; font-size: 15px; font-weight: 600;">${escapeHtml(deposit.guaranteeNo || "-")}</div>
                            </div>

                            <div>
                                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">DUE DATE</div>
                                <div style="color: #2c3e50; font-size: 15px; font-weight: 600;">${deposit.dueDate ? formatDateDMY(deposit.dueDate) : "-"}</div>
                            </div>

                            <div>
                                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">REQUIRED AMOUNT</div>
                                <div style="color: #2c3e50; font-size: 18px; font-weight: 700;">${deposit.currencySymbol || ""}${deposit.amount.toFixed(2)}</div>
                            </div>

                            <div>
                                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">CURRENCY</div>
                                <div style="color: #2c3e50; font-size: 15px; font-weight: 600;">${escapeHtml(deposit.currencyName || "-")}</div>
                            </div>

                            ${
                              deposit.payments > 0
                                ? `
                            <div>
                                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">NUMBER OF PAYMENTS</div>
                                <div style="color: #2c3e50; font-size: 15px; font-weight: 600;">${deposit.payments}</div>
                            </div>
                            `
                                : ""
                            }

                        </div>
                    </div>

                    <div class="modal-footer" style="background: #f5f5f5; padding: 16px 32px; border-top: 1px solid #e0e0e0;">
                        <button class="btn btn-secondary" onclick="closeViewModal('viewDepositModal')"
                            style="padding: 10px 24px; background: #ef4444; border: none; color: white; font-weight: 600;">
                            Close
                        </button>
                    </div>

                </div>
            </div>
        </div>
    `;

  document.body.insertAdjacentHTML("beforeend", modalHTML);
  document.body.style.overflow = "hidden";
}

// 4. CLOSE MODAL FUNCTION
function closeViewModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.remove();
    document.body.style.overflow = "";
  }
}

function viewOptionDetails(opt) {
  // Resolve display names for choice fields
  const optionTypeName = opt.optionTypeName || opt.optionType || "-";
  const optionHolderName = opt.optionHolderName || opt.optionHolder || "-";

  // Currency display
  let currencyDisplay = "-";
  if (opt.currencyId && window.currencies) {
    const c = window.currencies.find(
      (c) => c.transactioncurrencyid === opt.currencyId,
    );
    if (c) currencyDisplay = `${c.currencyname} (${c.isocurrencycode})`;
  }

  const modalHTML = `
    <div class="modal active" id="viewOptionModal" style="z-index: 100000;">
      <div class="modal-content" style="max-width: 800px; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.15);">
        <div class="modal-header" style="padding: 20px 32px;">
          <h3 class="modal-title" style="color: white; font-size: 18px; font-weight: 500; display: flex; align-items: center; gap: 12px;">
            <span>Lease Option Details</span>
          </h3>
          <button class="modal-close" onclick="closeViewModal('viewOptionModal')">x</button>
        </div>
        <div class="modal-body" style="max-height: 70vh; overflow-y: auto; padding: 0; background: #f5f5f5;">

          <!-- OPTION DETAILS SECTION -->
          <div style="background: white; margin: 0; padding: 24px 32px; border-bottom: 3px solid #f5f5f5;">
            <div style="padding-left: 0; margin-bottom: 24px;">
              <h4 style="color: var(--blue); font-size: 13px; font-weight: 700; letter-spacing: 0.5px; margin: 0;">OPTION DETAILS</h4>
            </div>
            <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px;">

              <div>
                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">OPTION TYPE</div>
                <div style="color: #2c3e50; font-size: 15px; font-weight: 600;">${escapeHtml(optionTypeName)}</div>
              </div>

              <div>
                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">OPTION HOLDER</div>
                <div style="color: #2c3e50; font-size: 15px; font-weight: 600;">${escapeHtml(optionHolderName)}</div>
              </div>

              <div>
                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">OPTION AVAILABLE FROM</div>
                <div style="color: #2c3e50; font-size: 15px; font-weight: 600;">${opt.executionDate ? formatDateDMY(opt.executionDate) : "-"}</div>
              </div>

              <div>
                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">OPTION EXPIRY DATE</div>
                <div style="color: #2c3e50; font-size: 15px; font-weight: 600;">${opt.expirationDate ? formatDateDMY(opt.expirationDate) : "-"}</div>
              </div>

              <div>
                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">NOTICE PERIOD (DAYS)</div>
                <div style="color: #2c3e50; font-size: 15px; font-weight: 600;">${opt.noticePeriod && opt.noticePeriod !== "" ? escapeHtml(String(opt.noticePeriod)) : "-"}</div>
              </div>

              <div>
                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">NOTICE SUBMISSION DEADLINE</div>
                <div style="color: #2c3e50; font-size: 15px; font-weight: 600;">${opt.noticeDate ? formatDateDMY(opt.noticeDate) : "-"}</div>
              </div>

            </div>
          </div>

          <!-- FINANCIAL DETAILS SECTION -->
          <div style="background: white; margin: 0; padding: 24px 32px; border-bottom: 3px solid #f5f5f5;">
            <div style="padding-left: 0; margin-bottom: 24px;">
              <h4 style="color: var(--blue); font-size: 13px; font-weight: 700; letter-spacing: 0.5px; margin: 0;">FINANCIAL DETAILS</h4>
            </div>
            <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px;">

              <div>
                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">CURRENCY</div>
                <div style="color: #2c3e50; font-size: 15px; font-weight: 600;">${escapeHtml(currencyDisplay)}</div>
              </div>

              <div>
                <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">PENALTY AMOUNT</div>
                <div style="color: #2c3e50; font-size: 15px; font-weight: 600;">${opt.penaltyAmount && opt.penaltyAmount !== "" ? escapeHtml(String(opt.penaltyAmount)) : "-"}</div>
              </div>

            </div>
          </div>

          <!-- ADDITIONAL INFORMATION SECTION -->
          ${
            opt.description
              ? `
          <div style="background: white; margin: 0; padding: 24px 32px;">
            <div style="padding-left: 0; margin-bottom: 24px;">
              <h4 style="color: var(--blue); font-size: 13px; font-weight: 700; letter-spacing: 0.5px; margin: 0;">ADDITIONAL INFORMATION</h4>
            </div>
            <div>
              <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">DESCRIPTION</div>
              <div style="color: #2c3e50; font-size: 14px; font-weight: 500; white-space: pre-wrap; word-break: break-word;">${escapeHtml(opt.description)}</div>
            </div>
          </div>`
              : ""
          }

        </div>
        <div class="modal-footer" style="background: #f5f5f5; padding: 16px 32px; border-top: 1px solid #e0e0e0;">
          <button class="btn btn-secondary" onclick="closeViewModal('viewOptionModal')" style="padding: 10px 24px; background: #ef4444; border: none; color: white; font-weight: 600;">
            Close
          </button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML("beforeend", modalHTML);
  document.body.style.overflow = "hidden";
}

function viewClauseDetails(clause, instanceIndex) {
  // Pick the right instance data if multi-instance
  let inst = {};
  if (clause.stepRentInstances && clause.stepRentInstances.length > 0) {
    inst = clause.stepRentInstances[instanceIndex] || {};
  } else if (clause.cpiInstances && clause.cpiInstances.length > 0) {
    inst = clause.cpiInstances[instanceIndex] || {};
  } else if (clause.turnoverInstances && clause.turnoverInstances.length > 0) {
    inst = clause.turnoverInstances[instanceIndex] || {};
  }

  const clauseType = clause.clauseType || "-";

  // Helper to look up choice field label by value
  function choiceLabel(fieldName, value) {
    if (!value) return "-";
    const map = choiceFieldMappings[fieldName];
    if (!map) return String(value);
    const entry = Object.entries(map).find(
      ([, v]) => String(v) === String(value),
    );
    return entry ? entry[0] : String(value);
  }

  // Helper to look up charge type name by ID
  function chargeTypeName(id) {
    if (!id) return "-";
    const found = Object.entries(chargeTypesLookup.stepIncrease || {}).find(
      ([, v]) => v === id,
    );
    return found ? found[0] : id;
  }

  // Helper to look up CPI type name by ID
  function cpiTypeName(id) {
    if (!id) return "-";
    const found = Object.entries(cpiTypesLookup || {}).find(
      ([, v]) => v === id,
    );
    return found ? found[0] : id;
  }

  // Helper to look up currency name by ID
  function currencyName(id) {
    if (!id) return "-";
    if (window.currencies) {
      const c = window.currencies.find((c) => c.transactioncurrencyid === id);
      if (c) return `${c.currencyname} (${c.isocurrencycode})`;
    }
    return id;
  }

  // Helper: render a field row
  function row(label, value) {
    if (!value || value === "-") return "";
    return `
      <div>
        <div style="color: #7f8c8d; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 8px;">${label}</div>
        <div style="color: #2c3e50; font-size: 15px; font-weight: 600;">${escapeHtml(String(value))}</div>
      </div>`;
  }

  function boolRow(label, value) {
    if (value === undefined || value === null || value === "") return "";
    return row(label, value === true || value === "true" ? "Yes" : "No");
  }

  // Build clause-type-specific fields HTML
  let specificHTML = "";

  if (clauseType === "Step Rent Indexation") {
    specificHTML = `
      <div style="background: white; margin: 0; padding: 24px 32px; border-bottom: 3px solid #f5f5f5;">
        <div style="margin-bottom: 24px;"><h4 style="color: var(--blue); font-size: 13px; font-weight: 700; letter-spacing: 0.5px; margin: 0;">STEP RENT DETAILS</h4></div>
        <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px;">
          ${row("CHARGE TYPE (STEP INCREASE)", chargeTypeName(inst.chargeTypeStepIncrease))}
          ${row("INCREASE TYPE", choiceLabel("array_increasetype", inst.increaseType))}
          ${inst.flatAmount ? row("FLAT AMOUNT", inst.flatAmount) : ""}
          ${inst.stepRentPercentage ? row("STEP RENT PERCENTAGE (%)", inst.stepRentPercentage) : ""}
          ${row("STEP RENT FREQUENCY", choiceLabel("array_steprentfrequency", inst.stepRentFrequency))}
          ${boolRow("ENABLE CUSTOM STEP RENT SCHEDULE", inst.enableCustomStepRentSchedule)}
          ${inst.enableCustomStepRentSchedule ? row("STEP RENT CYCLE START DATE", inst.stepRentCycleStartDate ? formatDateDMY(inst.stepRentCycleStartDate) : "-") : ""}
          ${inst.enableCustomStepRentSchedule ? row("STEP RENT CYCLE END DATE", inst.stepRentCycleEndDate ? formatDateDMY(inst.stepRentCycleEndDate) : "-") : ""}
          ${inst.clauseSummary ? row("CLAUSE SUMMARY", inst.clauseSummary) : ""}
        </div>
      </div>`;
  }

  if (clauseType === "Value Protection (CPI)") {
    specificHTML = `
      <div style="background: white; margin: 0; padding: 24px 32px; border-bottom: 3px solid #f5f5f5;">
        <div style="margin-bottom: 24px;"><h4 style="color: var(--blue); font-size: 13px; font-weight: 700; letter-spacing: 0.5px; margin: 0;">CPI DETAILS</h4></div>
        <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px;">
          ${inst.initialWaitingPeriod ? row("INITIAL WAITING PERIOD (MONTHS)", inst.initialWaitingPeriod) : ""}
          ${boolRow("ENABLE CUSTOM CPI SCHEDULE", inst.enableCustomCPISchedule)}
          ${inst.enableCustomCPISchedule ? row("CPI 2ND SCHEDULE START DATE", inst.cpiScheduleStartDate ? formatDateDMY(inst.cpiScheduleStartDate) : "-") : ""}
          ${inst.enableCustomCPISchedule ? row("CPI 2ND SCHEDULE END DATE", inst.cpiScheduleEndDate ? formatDateDMY(inst.cpiScheduleEndDate) : "-") : ""}
          ${boolRow("SKIP FIRST CPI SCHEDULE", inst.skipFirstCPISchedule)}
          ${row("CPI TYPE", cpiTypeName(inst.cpiType))}
          ${row("CHARGE TYPE (CPI)", chargeTypeName(inst.chargeTypeCPI))}
          ${row("CURRENT INDEX", inst.currentIndex)}
          ${row("CPI RENT FREQUENCY", choiceLabel("array_cpirentfrequency", inst.cpiRentFrequency))}
          ${row("CPI REFERENCE MONTH", choiceLabel("array_cpireferencemonth", inst.cpiReferenceMonth))}
          ${inst.cpiCustomMonth ? row("CPI CUSTOM MONTH", choiceLabel("array_cpicustommonth", inst.cpiCustomMonth)) : ""}
          ${inst.minimumTimeInterval ? row("MINIMUM TIME INTERVAL (MONTHS)", inst.minimumTimeInterval) : ""}
          ${inst.triggerValue ? row("TRIGGER VALUE (%)", inst.triggerValue) : ""}
          ${row("INCREASE TYPE (CPI)", choiceLabel("array_increasetypecpirentprocess", inst.increaseTypeCPI))}
          ${inst.flatAmountCPI ? row("FLAT AMOUNT (CPI)", inst.flatAmountCPI) : ""}
          ${inst.minimumIncreasePercentage ? row("MINIMUM INCREASE PERCENTAGE (%)", inst.minimumIncreasePercentage) : ""}
          ${inst.maximumIncreasePercentage ? row("MAXIMUM INCREASE PERCENTAGE (%)", inst.maximumIncreasePercentage) : ""}
          ${inst.clauseSummary ? row("CLAUSE SUMMARY", inst.clauseSummary) : ""}
        </div>
      </div>`;
  }

  if (clauseType === "Turnover Rent") {
    specificHTML = `
      <div style="background: white; margin: 0; padding: 24px 32px; border-bottom: 3px solid #f5f5f5;">
        <div style="margin-bottom: 24px;"><h4 style="color: var(--blue); font-size: 13px; font-weight: 700; letter-spacing: 0.5px; margin: 0;">TURNOVER RENT DETAILS</h4></div>
        <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px;">
          ${boolRow("SUBJECT TO VAT", inst.subjectToVAT)}
          ${boolRow("TAX INCLUDED", inst.taxIncluded)}
          ${boolRow("ENABLE OCR", inst.enableOCR)}
          ${row("TURNOVER RENT BASIS", choiceLabel("array_turnoverrentbasis", inst.turnoverRentBasis))}
          ${row("CURRENCY", currencyName(inst.currency))}
          ${inst.salesThreshold ? row("SALES THRESHOLD", inst.salesThreshold) : ""}
          ${row("CHARGE TYPE FOR ADVANCE", chargeTypeName(inst.chargeTypeTurnover))}
          ${inst.enableOCR && inst.secondaryChargeTypeTurnover ? row("SECONDARY CHARGE TYPE FOR ADVANCE", chargeTypeName(inst.secondaryChargeTypeTurnover)) : ""}
          ${row("SETTLEMENT CYCLE", choiceLabel("array_settlementcycle", inst.settlementCycle))}
          ${boolRow("ENABLE PRORATION", inst.enableProration)}
          ${boolRow("ENABLE CUSTOM SCHEDULE", inst.enableCustomTurnoverSchedule)}
          ${inst.enableCustomTurnoverSchedule ? row("TURNOVER CYCLE START DATE", inst.turnoverCycleStartDate || "-") : ""}
          ${inst.enableCustomTurnoverSchedule ? row("TURNOVER CYCLE END DATE", inst.turnoverCycleEndDate || "-") : ""}
          ${row("REPORTING CYCLE", choiceLabel("array_reportingcycle", inst.reportingCycle))}
          ${row("TURNOVER RENT CALCULATION TYPE", choiceLabel("array_turnoverrentcalculationtype", inst.turnoverRentCalculationType))}
          ${row("INCREASE TYPE", choiceLabel("array_increasetypeturnoverrent", inst.increaseTypeTurnover))}
          ${inst.flatAmountTurnoverRent ? row("FLAT AMOUNT (TURNOVER RENT)", inst.flatAmountTurnoverRent) : ""}
          ${inst.minSalesRentAmount ? row("MINIMUM SALES-BASED RENT AMOUNT", inst.minSalesRentAmount) : ""}
          ${inst.turnoverRate ? row("TURNOVER RATE (%)", inst.turnoverRate) : ""}
          ${inst.minimumTurnoverPercentage ? row("MINIMUM TURNOVER PERCENTAGE", inst.minimumTurnoverPercentage) : ""}
          ${inst.clauseSummary ? row("CLAUSE SUMMARY", inst.clauseSummary) : ""}
        </div>
      </div>`;
  }

  const modalHTML = `
    <div class="modal active" id="viewClauseModal" style="z-index: 100000;">
      <div class="modal-content" style="max-width: 800px; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.15);">
        <div class="modal-header" style="padding: 20px 32px;">
          <h3 class="modal-title" style="color: white; font-size: 18px; font-weight: 500; display: flex; align-items: center; gap: 12px;">
            <span>Clause Details - ${escapeHtml(clauseType)}</span>
          </h3>
          <button class="modal-close" onclick="closeViewModal('viewClauseModal')">x</button>
        </div>
        <div class="modal-body" style="max-height: 70vh; overflow-y: auto; padding: 0; background: #f5f5f5;">

          <!-- BASE INFORMATION -->
          <div style="background: white; margin: 0; padding: 24px 32px; border-bottom: 3px solid #f5f5f5;">
            <div style="margin-bottom: 24px;"><h4 style="color: var(--blue); font-size: 13px; font-weight: 700; letter-spacing: 0.5px; margin: 0;">CLAUSE INFORMATION</h4></div>
            <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px;">
              ${row("CLAUSE TYPE", clauseType)}
              ${row("EFFECTIVE DATE", inst.effectiveDate || clause.effectiveDate ? formatDateDMY(inst.effectiveDate || clause.effectiveDate) : "-")}
              ${row("EXPIRY DATE", inst.expiryDate || clause.expiryDate ? formatDateDMY(inst.expiryDate || clause.expiryDate) : "-")}
              ${clause.description && !inst.clauseSummary ? row("DESCRIPTION", clause.description) : ""}
            </div>
          </div>

          ${specificHTML}

        </div>
        <div class="modal-footer" style="background: #f5f5f5; padding: 16px 32px; border-top: 1px solid #e0e0e0;">
          <button class="btn btn-secondary" onclick="closeViewModal('viewClauseModal')" style="padding: 10px 24px; background: #ef4444; border: none; color: white; font-weight: 600;">
            Close
          </button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML("beforeend", modalHTML);
  document.body.style.overflow = "hidden";
}

//-------------------------------------------------------------------------Stage -5.1 -- FORM SUBMISSION FUNCTIONS  --------------------------------------------------------------------//

// Validate form (final validation)
function validateForm() {
  // Basic required fields
  const leaseName = document.getElementById("leaseName").value;
  const leaseType = document.getElementById("leaseType").value;
  const leaseTermType = document.getElementById("leaseTermType").value;
  const tenantId = document.getElementById("tenantId").value;
  const propertyId = document.getElementById("propertyId").value;
  const startDate = document.getElementById("startDate").value;

  if (!leaseName) {
    showNotification(" Please enter a lease name", "error");
    goToStage(1);
    return false;
  }

  if (!leaseType) {
    showNotification(" Please select a lease type", "error");
    goToStage(1);
    return false;
  }

  if (!leaseTermType) {
    showNotification(" Please select a lease term type", "error");
    goToStage(1);
    return false;
  }

  if (!tenantId) {
    showNotification(" Please select a tenant", "error");
    goToStage(1);
    return false;
  }

  if (!propertyId) {
    showNotification(" Please select a property", "error");
    goToStage(1);
    return false;
  }

  if (!startDate) {
    showNotification(" Please select a lease start date", "error");
    goToStage(2);
    return false;
  }

  const leaseTermTypeSelect = document.getElementById("leaseTermType");
  const selectedOption =
    leaseTermTypeSelect.options[leaseTermTypeSelect.selectedIndex];
  const isShortTerm =
    selectedOption &&
    selectedOption.textContent.toLowerCase().includes("month-to-month");

  const endDate = document.getElementById("endDate").value;

  if (!endDate) {
    showNotification(" Please select a lease end date", "error");
    goToStage(2);
    return false;
  }

  if (new Date(endDate) < new Date(startDate)) {
    showNotification(
      " Lease end date cannot be earlier than start date",
      "error",
    );
    goToStage(2);
    return false;
  }

  // Check units
  if (!isShortTerm && units.length === 0) {
    showNotification(" Please select at least one unit", "error");
    goToStage(2);
    return false;
  }

  // Check total area
  if (isShortTerm) {
    // Total Area is OPTIONAL for Month-to-Month
    const totalAreaInput = document.getElementById("totalUnitsArea");
    const totalAreaVal = parseFloat(totalAreaInput?.value);
    totalUnitsAreaValue = totalAreaVal > 0 ? totalAreaVal : 0;
  } else {
    const totalAreaInput = document.getElementById("totalUnitsArea");
    const totalAreaVal = parseFloat(totalAreaInput?.value);
    if (!totalAreaVal || totalAreaVal <= 0) {
      showNotification(" Please ensure units have a valid total area", "error");
      goToStage(2);
      return false;
    }
    totalUnitsAreaValue = totalAreaVal;
  }

  console.log(" Form validation passed:", {
    isShortTerm: isShortTerm,
    hasEndDate: !isShortTerm,
    unitsCount: units.length,
    chargesCount: recurringCharges.length,
    depositsCount: deposits.length,
    totalArea: totalUnitsAreaValue,
  });

  return true;
}

// Save and Close - directly saves and opens form without confirmation
//======================================================================================
// STAGE 5: LEASE OPTIONS (Session-only - saved to Dataverse after lease is created)
//======================================================================================

// Session array to hold options before the lease agreement is created
window.sessionLeaseOptions = window.sessionLeaseOptions || [];

/**
 * Renders the options grid in stage 5.
 * Called when entering stage 5 and after adding/editing options.
 */
function renderOptionsGrid() {
  const tbody = document.querySelector("#optionsGrid tbody");
  if (!tbody) return;

  if (!window.sessionLeaseOptions.length) {
    tbody.innerHTML = `
      <tr><td colspan="6">
        <div class="empty-state">
          <span class="empty-icon">&#x1F4C5;</span>
          <p>No options configured yet</p>
          <p class="empty-hint">Click "Add Option" above to create one</p>
        </div>
      </td></tr>`;
    return;
  }

  tbody.innerHTML = window.sessionLeaseOptions
    .map((opt, idx) => {
      return `
    <tr>
      <td style="font-weight:600;color:var(--text);">
        ${opt.optionTypeName ? escapeHtml(opt.optionTypeName) : '<span class="tag status-incomplete">Select type</span>'}
      </td>
      <td>${opt.optionHolderName ? `<span class="tag tag-blue">${escapeHtml(opt.optionHolderName)}</span>` : '<span style="color:var(--hint);">&mdash;</span>'}</td>
      <td style="color:var(--sub);">${opt.executionDate ? formatDateDMY(opt.executionDate) : "&mdash;"}</td>
      <td style="color:var(--sub);">${opt.expirationDate ? formatDateDMY(opt.expirationDate) : "&mdash;"}</td>
      <td style="color:var(--sub);">${opt.noticeDate ? formatDateDMY(opt.noticeDate) : "&mdash;"}</td>
      <td style="text-align:center;white-space:nowrap;">
        <span class="record-actions" style="justify-content:center;">
          <button class="action-edit" onclick="editSessionOption(${idx})" title="Edit"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
          <button class="action-delete" onclick="removeSessionOption(${idx})" title="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg></button>
        </span>
      </td>
    </tr>
  `;
    })
    .join("");
}

/** Removes an option by index from the session array and re-renders */
window.removeSessionOption = function (idx) {
  window.sessionLeaseOptions.splice(idx, 1);
  renderOptionsGrid();
};

/** Opens the Add/Edit modal pre-filled with existing option data */
window.editSessionOption = async function (idx) {
  const opt = window.sessionLeaseOptions[idx];
  if (!opt) return;

  const modal = document.getElementById("optionModalOverlay");
  if (!modal) return;

  // Populate dropdowns before showing
  await _populateOptionCurrencyDropdown();
  await _populateOptionTypeDropdown();
  await _populateOptionHolderDropdown();

  document.getElementById("optionModalTitle").textContent = "Edit Lease Option";
  document.getElementById("btnSaveOptionText").textContent = "Update Option";
  document.getElementById("optionEditIndex").value = idx;

  document.getElementById("optionPenalty").value = opt.penaltyAmount || "";
  const optAvailFrom = document.getElementById("optionAvailableFrom");
  if (optAvailFrom) optAvailFrom.value = opt.executionDate || "";
  const optNoticeDeadline = document.getElementById("optionNoticeDeadline");
  if (optNoticeDeadline) optNoticeDeadline.value = opt.noticeDate || "";
  const optExpiry = document.getElementById("optionExpiryDate");
  if (optExpiry) optExpiry.value = opt.expirationDate || "";
  document.getElementById("optionDescription").value = opt.description || "";

  // Set currency after dropdown is populated
  const currSel = document.getElementById("optionCurrency");
  if (currSel && opt.currencyId) currSel.value = opt.currencyId;

  // Set type after dropdown is populated
  const typeSel = document.getElementById("optionType");
  if (typeSel && opt.optionType) typeSel.value = opt.optionType;

  // Set holder after dropdown is populated
  const holderSel = document.getElementById("optionHolder");
  if (holderSel && opt.optionHolder) holderSel.value = opt.optionHolder;

  // Restore notice period
  const noticePeriodEl = document.getElementById("optionNoticePeriod");
  if (noticePeriodEl && opt.noticePeriod)
    noticePeriodEl.value = opt.noticePeriod;

  // Apply lease date constraints
  const leaseStartDate = document.getElementById("startDate")?.value || "";
  const leaseEndDate = document.getElementById("endDate")?.value || "";

  if (optAvailFrom) {
    if (leaseStartDate) optAvailFrom.min = leaseStartDate;
    if (leaseEndDate) optAvailFrom.max = leaseEndDate;
  }
  if (optExpiry) {
    // min = max(leaseStart, availableFrom)
    const effMin = optAvailFrom?.value || leaseStartDate;
    if (effMin) optExpiry.min = effMin;
    if (leaseEndDate) optExpiry.max = leaseEndDate;
  }
  if (optNoticeDeadline) {
    if (leaseStartDate) optNoticeDeadline.min = leaseStartDate;
    // max for notice deadline = expiry date
    if (optExpiry?.value) optNoticeDeadline.max = optExpiry.value;
    else if (leaseEndDate) optNoticeDeadline.max = leaseEndDate;
  }

  modal.style.display = "flex";
};

/**
 * Populates the optionCurrency dropdown from window.currencies cache.
 * Falls back to loadCurrencies() if cache is empty.
 */
async function _populateOptionCurrencyDropdown() {
  const currSel = document.getElementById("optionCurrency");
  if (!currSel) return;

  // Load currencies if not cached
  if (!window.currencies || !window.currencies.length) {
    try {
      const loaded = await loadCurrencies();
      window.currencies = loaded;
    } catch (e) {
      console.error("Failed to load currencies for option modal:", e);
      return;
    }
  }

  // Always rebuild the dropdown to ensure PLN default is applied fresh
  currSel.innerHTML = '<option value="">Select currency</option>';
  let plnCurrencyId = null;

  window.currencies.forEach((currency) => {
    const opt = document.createElement("option");
    opt.value = currency.transactioncurrencyid;
    opt.textContent = `${currency.currencyname} (${currency.isocurrencycode})`;
    currSel.appendChild(opt);
    if (
      currency.isocurrencycode &&
      currency.isocurrencycode.toUpperCase() === "PLN"
    ) {
      plnCurrencyId = currency.transactioncurrencyid;
    }
  });

  // Always set PLN as default currency
  if (plnCurrencyId) {
    currSel.value = plnCurrencyId;
    console.log(" Default currency set to PLN");
  }
}

/** Populates the optionType dropdown from the array_OptionType global choice field */
async function _populateOptionTypeDropdown() {
  const typeSel = document.getElementById("optionType");
  if (!typeSel) return;

  // Already populated - don't rebuild
  if (typeSel.options.length > 1) return;

  if (!window.optionTypes || !window.optionTypes.length) {
    try {
      const loaded = await loadOptionTypes();
      window.optionTypes = loaded;
    } catch (e) {
      console.error("Failed to load option types:", e);
      return;
    }
  }

  typeSel.innerHTML = '<option value="">Select type</option>';
  const sorted = (window.optionTypes || []).sort((a, b) => a.Value - b.Value);
  sorted.forEach((item) => {
    const label =
      item.Label?.UserLocalizedLabel?.Label ||
      item.Label?.LocalizedLabels?.[0]?.Label ||
      "Unknown";
    const opt = document.createElement("option");
    opt.value = item.Value;
    opt.textContent = label;
    typeSel.appendChild(opt);
  });
}

/** Populates the optionHolder dropdown from the array_optionholder global choice field */
async function _populateOptionHolderDropdown() {
  const holderSel = document.getElementById("optionHolder");
  if (!holderSel) return;

  // Already populated - don't rebuild (mirrors _populateOptionTypeDropdown guard)
  if (holderSel.options.length > 1) return;

  if (!window.optionHolderTypes || !window.optionHolderTypes.length) {
    try {
      const loaded = await loadOptionHolderTypes();
      window.optionHolderTypes = loaded;
    } catch (e) {
      console.error("Failed to load option holder types:", e);
      return;
    }
  }

  holderSel.innerHTML = '<option value="">-- Select Option Holder --</option>';
  const sorted = (window.optionHolderTypes || []).sort(
    (a, b) => a.Value - b.Value,
  );
  sorted.forEach((item) => {
    const label =
      item.Label?.UserLocalizedLabel?.Label ||
      item.Label?.LocalizedLabels?.[0]?.Label ||
      "Unknown";
    const opt = document.createElement("option");
    opt.value = item.Value;
    opt.textContent = label;
    holderSel.appendChild(opt);
  });
}

/**
 * Auto-populates the Notice Submission Deadline as:
 *   Option Expiry Date - Notice Period (days)
 * Triggered by oninput on optionNoticePeriod or onchange on optionExpiryDate.
 */
function autoPopulateNoticeDeadline() {
  const noticePeriodInput = document.getElementById("optionNoticePeriod");
  const noticeDeadlineInput = document.getElementById("optionNoticeDeadline");
  if (!noticePeriodInput || !noticeDeadlineInput) return;

  const noticePeriodDays = parseInt(noticePeriodInput.value, 10);

  // Get option expiry date from the option modal
  const optionExpiryInput = document.getElementById("optionExpiryDate");
  const optionAvailableFromInput = document.getElementById(
    "optionAvailableFrom",
  );
  const optionExpiryValue = optionExpiryInput ? optionExpiryInput.value : "";
  const optionAvailableFromValue = optionAvailableFromInput
    ? optionAvailableFromInput.value
    : "";

  if (!optionExpiryValue || isNaN(noticePeriodDays) || noticePeriodDays < 0) {
    noticeDeadlineInput.value = "";
    return;
  }

  const optionExpiryDate = new Date(optionExpiryValue);
  if (isNaN(optionExpiryDate.getTime())) {
    noticeDeadlineInput.value = "";
    return;
  }

  // Compute the candidate deadline: Expiry Date - Notice Period Days
  const computedDeadline = new Date(optionExpiryDate);
  computedDeadline.setDate(computedDeadline.getDate() - noticePeriodDays);
  computedDeadline.setHours(0, 0, 0, 0);

  // -- Validation: computed deadline must be >= Option Available From --------
  if (optionAvailableFromValue) {
    const availableFrom = new Date(optionAvailableFromValue);
    availableFrom.setHours(0, 0, 0, 0);

    if (computedDeadline < availableFrom) {
      showNotification(
        ` A notice period of ${noticePeriodDays} days is not valid - the resulting Notice Submission Deadline (${formatDateDMY(formatDateForInput(computedDeadline))}) would fall before the Option Available From date (${formatDateDMY(optionAvailableFromValue)}). Please enter a valid number of days.`,
        "error",
      );
      noticePeriodInput.value = "";
      noticeDeadlineInput.value = "";
      return;
    }
  }

  // All good - set the deadline
  noticeDeadlineInput.value = formatDateForInput(computedDeadline);
  console.log(` Notice deadline auto-populated: ${noticeDeadlineInput.value}`);
}

/**
 * Wires up the Add Option modal open/close/save buttons.
 * Called once when entering stage 5.
 */
function initializeOptionsModal() {
  const modal = document.getElementById("optionModalOverlay");
  const addBtn = document.getElementById("openAddOptionBtn");
  const cancelBtn = document.getElementById("cancelOptionBtn");
  const cancelBtn2 = document.getElementById("cancelOptionBtn2");
  const saveBtn = document.getElementById("saveOptionBtn");

  if (!modal || !addBtn) return;

  const newAddBtn = addBtn.cloneNode(true);
  addBtn.parentNode.replaceChild(newAddBtn, addBtn);

  const newCancelBtn = cancelBtn ? cancelBtn.cloneNode(true) : null;
  if (cancelBtn && newCancelBtn)
    cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);

  const newCancelBtn2 = cancelBtn2 ? cancelBtn2.cloneNode(true) : null;
  if (cancelBtn2 && newCancelBtn2)
    cancelBtn2.parentNode.replaceChild(newCancelBtn2, cancelBtn2);

  const newSaveBtn = saveBtn ? saveBtn.cloneNode(true) : null;
  if (saveBtn && newSaveBtn)
    saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);

  // -- Helper: apply lease date constraints to all option date inputs --------
  function applyOptionDateConstraints() {
    const leaseStartDate = document.getElementById("startDate")?.value || "";
    const leaseEndDate = document.getElementById("endDate")?.value || "";

    const availableFromEl = document.getElementById("optionAvailableFrom");
    const expiryDateEl = document.getElementById("optionExpiryDate");
    const noticeDeadlineEl = document.getElementById("optionNoticeDeadline");

    if (availableFromEl) {
      if (leaseStartDate) availableFromEl.min = leaseStartDate;
      if (leaseEndDate) availableFromEl.max = leaseEndDate;
    }
    if (expiryDateEl) {
      if (leaseStartDate) expiryDateEl.min = leaseStartDate;
      if (leaseEndDate) expiryDateEl.max = leaseEndDate;
    }
    if (noticeDeadlineEl) {
      if (leaseStartDate) noticeDeadlineEl.min = leaseStartDate;
      if (leaseEndDate) noticeDeadlineEl.max = leaseEndDate;
    }
  }

  newAddBtn.addEventListener("click", async () => {
    document.getElementById("optionModalTitle").textContent =
      "Add Lease Option";
    document.getElementById("btnSaveOptionText").textContent = "Add Option";
    document.getElementById("optionEditIndex").value = "-1";
    clearOptionModalForm();
    await _populateOptionCurrencyDropdown();
    await _populateOptionTypeDropdown();
    await _populateOptionHolderDropdown();

    setTimeout(() => {
      applyOptionDateConstraints();

      const leaseStartDate = document.getElementById("startDate")?.value || "";
      const leaseEndDate = document.getElementById("endDate")?.value || "";

      const availableFromEl = document.getElementById("optionAvailableFrom");
      const expiryDateEl = document.getElementById("optionExpiryDate");
      const noticeDeadlineEl = document.getElementById("optionNoticeDeadline");

      //  AUTO-POPULATE Option Available From from lease start date
      if (availableFromEl && leaseStartDate) {
        availableFromEl.value = leaseStartDate;
        availableFromEl.setAttribute("data-user-input", "true");
        updateFieldState(availableFromEl);
        // Update expiry min to match available from
        if (expiryDateEl) expiryDateEl.min = leaseStartDate;
      }

      //  AUTO-POPULATE Option Expiry Date from lease end date (only if it exists)
      if (expiryDateEl && leaseEndDate) {
        expiryDateEl.value = leaseEndDate;
        expiryDateEl.setAttribute("data-user-input", "true");
        updateFieldState(expiryDateEl);
        // Update notice deadline max to match expiry
        if (noticeDeadlineEl) noticeDeadlineEl.max = leaseEndDate;
      }
    }, 50);

    modal.style.display = "flex";
  });

  // Re-wire expiry date change - auto-populate notice deadline + re-apply constraints
  const expiryDateEl = document.getElementById("optionExpiryDate");
  if (expiryDateEl) {
    const newExpiryEl = expiryDateEl.cloneNode(true);
    expiryDateEl.parentNode.replaceChild(newExpiryEl, expiryDateEl);
    newExpiryEl.addEventListener("change", function () {
      autoPopulateNoticeDeadline();

      // Validate expiry is after available-from
      const availableFromEl = document.getElementById("optionAvailableFrom");
      if (availableFromEl?.value && this.value) {
        if (new Date(this.value) < new Date(availableFromEl.value)) {
          showNotification(
            " Option Expiry Date must be on or after the Available From date",
            "error",
          );
          this.value = "";
          return;
        }
      }

      // Update notice deadline max to match new expiry
      const noticeDeadlineEl = document.getElementById("optionNoticeDeadline");
      if (noticeDeadlineEl && this.value) {
        noticeDeadlineEl.max = this.value;
      }
    });
  }

  // Available From change - update expiry min
  const availableFromEl = document.getElementById("optionAvailableFrom");
  if (availableFromEl) {
    const newAvailEl = availableFromEl.cloneNode(true);
    availableFromEl.parentNode.replaceChild(newAvailEl, availableFromEl);
    newAvailEl.addEventListener("change", function () {
      const expiryEl = document.getElementById("optionExpiryDate");
      if (expiryEl) {
        expiryEl.min =
          this.value || document.getElementById("startDate")?.value || "";

        if (expiryEl.value && new Date(expiryEl.value) < new Date(this.value)) {
          expiryEl.value = "";
          const noticeEl = document.getElementById("optionNoticeDeadline");
          if (noticeEl) noticeEl.value = "";
          showNotification(
            "  Option Expiry Date was cleared as it was before the new Available From date",
            "warning",
          );
        }
      }

      // Re-validate notice period if already entered, since Available From changed
      const noticePeriodEl = document.getElementById("optionNoticePeriod");
      if (noticePeriodEl && noticePeriodEl.value) {
        autoPopulateNoticeDeadline();
      }
    });
  }

  const closeModal = () => {
    modal.style.display = "none";
    clearOptionModalForm();
    document.getElementById("optionEditIndex").value = "-1";
    document.getElementById("optionModalTitle").textContent =
      "Add Lease Option";
    document.getElementById("btnSaveOptionText").textContent = "Add Option";
  };

  if (newCancelBtn) newCancelBtn.addEventListener("click", closeModal);
  if (newCancelBtn2) newCancelBtn2.addEventListener("click", closeModal);

  if (newSaveBtn) {
    newSaveBtn.addEventListener("click", () => {
      const leaseStartDate = document.getElementById("startDate")?.value || "";
      const leaseEndDate = document.getElementById("endDate")?.value || "";

      const optionTypeVal = document.getElementById("optionType")?.value || "";
      const optionHolderVal =
        document.getElementById("optionHolder")?.value || "";
      const availableFromVal =
        document.getElementById("optionAvailableFrom")?.value || "";
      const expiryDateVal =
        document.getElementById("optionExpiryDate")?.value || "";
      const noticeDeadlineVal =
        document.getElementById("optionNoticeDeadline")?.value || "";
      const noticePeriodVal =
        document.getElementById("optionNoticePeriod")?.value || "";

      // -- Required field validation -----------------------------------------
      if (!optionTypeVal) {
        showNotification(" Please select an Option Type", "error");
        return;
      }
      if (!optionHolderVal) {
        showNotification(" Please select an Option Holder", "error");
        return;
      }
      if (!availableFromVal) {
        showNotification(
          " Please select an Option Available From date",
          "error",
        );
        return;
      }
      if (!expiryDateVal) {
        showNotification(" Please select an Option Expiry Date", "error");
        return;
      }
      if (!noticeDeadlineVal) {
        showNotification(
          " Please select a Notice Submission Deadline",
          "error",
        );
        return;
      }

      // -- Notice period vs Available From cross-validation ------------------
      // If notice period days are provided, verify the computed deadline
      // (Expiry - noticeDays) does not land before the Available From date.
      if (noticePeriodVal && availableFromVal && expiryDateVal) {
        const noticeDaysCheck = parseInt(noticePeriodVal, 10);
        if (!isNaN(noticeDaysCheck) && noticeDaysCheck >= 0) {
          const expiryCheck = new Date(expiryDateVal);
          const computedCheck = new Date(expiryCheck);
          computedCheck.setDate(computedCheck.getDate() - noticeDaysCheck);
          computedCheck.setHours(0, 0, 0, 0);

          const availFromCheck = new Date(availableFromVal);
          availFromCheck.setHours(0, 0, 0, 0);

          if (computedCheck < availFromCheck) {
            showNotification(
              ` The notice period of ${noticeDaysCheck} days is not valid - it would place the Notice Submission Deadline before the Option Available From date. Please enter a valid number of days.`,
              "error",
            );
            return;
          }
        }
      }

      // -- Notice Submission Deadline vs Available From -----------------------
      if (
        noticeDeadlineVal &&
        availableFromVal &&
        new Date(noticeDeadlineVal) < new Date(availableFromVal)
      ) {
        showNotification(
          " Notice Submission Deadline cannot be before the Option Available From date",
          "error",
        );
        return;
      }

      // -- Lease date range validation ---------------------------------------
      const availableFromObj = new Date(availableFromVal);
      const expiryDateObj = new Date(expiryDateVal);
      const noticeDeadlineObj = new Date(noticeDeadlineVal);

      if (leaseStartDate) {
        const leaseStartObj = new Date(leaseStartDate);

        if (availableFromObj < leaseStartObj) {
          showNotification(
            ` Option Available From cannot be before the Lease Start Date (${formatDateDMY(leaseStartDate)})`,
            "error",
          );
          return;
        }
        if (expiryDateObj < leaseStartObj) {
          showNotification(
            ` Option Expiry Date cannot be before the Lease Start Date (${formatDateDMY(leaseStartDate)})`,
            "error",
          );
          return;
        }
        if (noticeDeadlineObj < leaseStartObj) {
          showNotification(
            ` Notice Submission Deadline cannot be before the Lease Start Date (${formatDateDMY(leaseStartDate)})`,
            "error",
          );
          return;
        }
      }

      if (leaseEndDate) {
        const leaseEndObj = new Date(leaseEndDate);

        if (availableFromObj > leaseEndObj) {
          showNotification(
            ` Option Available From cannot be after the Lease End Date (${formatDateDMY(leaseEndDate)})`,
            "error",
          );
          return;
        }
        if (expiryDateObj > leaseEndObj) {
          showNotification(
            ` Option Expiry Date cannot be after the Lease End Date (${formatDateDMY(leaseEndDate)})`,
            "error",
          );
          return;
        }
        if (noticeDeadlineObj > leaseEndObj) {
          showNotification(
            ` Notice Submission Deadline cannot be after the Lease End Date (${formatDateDMY(leaseEndDate)})`,
            "error",
          );
          return;
        }
      }

      // -- Cross-field date validation ----------------------------------------
      if (
        availableFromVal &&
        expiryDateVal &&
        new Date(expiryDateVal) < new Date(availableFromVal)
      ) {
        showNotification(
          " Option Expiry Date must be on or after the Available From date",
          "error",
        );
        return;
      }
      if (
        noticeDeadlineVal &&
        expiryDateVal &&
        new Date(noticeDeadlineVal) > new Date(expiryDateVal)
      ) {
        showNotification(
          " Notice Submission Deadline must be on or before the Option Expiry Date",
          "error",
        );
        return;
      }

      // -- Save --------------------------------------------------------------
      const optionData = {
        optionType: optionTypeVal,
        optionTypeName:
          document.getElementById("optionType")?.selectedOptions[0]?.text || "",
        optionHolder: optionHolderVal,
        optionHolderName:
          document.getElementById("optionHolder")?.selectedOptions[0]?.text ||
          "",
        penaltyAmount: document.getElementById("optionPenalty")?.value || "",
        currencyId: document.getElementById("optionCurrency")?.value || "",
        noticePeriod: noticePeriodVal,
        executionDate: availableFromVal,
        noticeDate: noticeDeadlineVal,
        expirationDate: expiryDateVal,
        description: document.getElementById("optionDescription")?.value || "",
      };

      const editIndex = parseInt(
        document.getElementById("optionEditIndex")?.value ?? "-1",
      );

      if (editIndex >= 0 && editIndex < window.sessionLeaseOptions.length) {
        window.sessionLeaseOptions[editIndex] = optionData;
        showNotification("Lease option updated.", "success");
      } else {
        window.sessionLeaseOptions.push(optionData);
        showNotification("Lease option added.", "success");
      }

      renderOptionsGrid();
      closeModal();
    });
  }
}

function clearOptionModalForm() {
  [
    "optionType",
    "optionHolder",
    "optionPenalty",
    "optionCurrency",
    "optionAvailableFrom",
    "optionNoticeDeadline",
    "optionExpiryDate",
    "optionNoticePeriod",
    "optionDescription",
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
}

/**
 * Saves all session options to Dataverse after the lease agreement is created.
 * @param {string} leaseAgreementId - The GUID of the newly created lease.
 */
async function saveLeaseOptions(leaseAgreementId) {
  if (!window.sessionLeaseOptions || !window.sessionLeaseOptions.length) {
    console.log("i No lease options to save.");
    return;
  }

  console.log(
    ` Saving ${window.sessionLeaseOptions.length} lease option(s)...`,
  );

  // GUID validation helper - prevents OData annotation-without-value error on lookup fields
  const isValidGuid = (id) =>
    typeof id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      id.trim(),
    );

  for (const opt of window.sessionLeaseOptions) {
    try {
      // Save all fields from the option form popup that exist on array_option
      const payload = {};

      // Lease Agreement lookup - only set when a valid GUID is available.
      // Sending the @odata.bind annotation without a resolvable GUID causes the
      // OData "undeclared property ... only has property annotations" error (0x80048d19).
      if (isValidGuid(leaseAgreementId)) {
        payload["array_LeaseAgreement@odata.bind"] =
          `/array_leaseagreements(${leaseAgreementId.trim()})`;
      } else {
        console.warn(
          "  array_LeaseAgreement@odata.bind skipped - invalid or missing leaseAgreementId:",
          leaseAgreementId,
        );
      }

      // Available From - Date field (array_optionavailablefrom)
      if (opt.executionDate && opt.executionDate !== "") {
        payload["array_optionavailablefrom"] = convertToISODate(
          opt.executionDate,
        );
      }

      // Expiry Date - Date field (array_optionexpirydate)
      if (opt.expirationDate && opt.expirationDate !== "") {
        payload["array_optionexpirydate"] = convertToISODate(
          opt.expirationDate,
        );
      }

      // Notice Submission Deadline - Date field (array_noticesubmissiondeadline)
      if (opt.noticeDate && opt.noticeDate !== "") {
        payload["array_noticesubmissiondeadline"] = convertToISODate(
          opt.noticeDate,
        );
      }

      // Option Type - Choice field
      if (opt.optionType)
        payload["array_optiontype"] = parseInt(opt.optionType);

      // Option Holder - Choice field
      if (opt.optionHolder)
        payload["array_optionholder"] = parseInt(opt.optionHolder);

      // Notice Period - Integer (days)
      if (opt.noticePeriod && opt.noticePeriod !== "") {
        payload["array_noticeperiod"] = parseInt(opt.noticePeriod);
      }

      // Penalty Amount - Money field (requires transactioncurrencyid)
      if (opt.penaltyAmount && opt.penaltyAmount !== "") {
        payload["array_penaltyamount"] = parseFloat(opt.penaltyAmount);
      }
      if (isValidGuid(opt.currencyId)) {
        payload["transactioncurrencyid@odata.bind"] =
          `/transactioncurrencies(${opt.currencyId.trim()})`;
      }

      // Description - Text field
      if (opt.description && opt.description !== "") {
        payload["array_description"] = opt.description;
      }

      console.log(
        "&#x1F4CB; [Option] In-memory option object:",
        JSON.parse(JSON.stringify(opt)),
      );
      console.log(
        "&#x1F4CB; [Option] Dataverse payload being sent:",
        JSON.parse(JSON.stringify(payload)),
      );
      await XrmContext.WebApi.createRecord("array_option", payload);
      console.log(
        ` Option saved (type: ${opt.optionTypeName || opt.optionType || "unknown"})`,
      );
    } catch (err) {
      console.error(
        ` Failed to save option (type: ${opt.optionTypeName || opt.optionType || "unknown"}):`,
        err,
      );
    }
  }
}

//======================================================================================
// STAGE 6: LEASE CLAUSES (Configured before lease is created - saved after creation)
//======================================================================================

// Session array to hold captured clause data
window.sessionLeaseClauses = window.sessionLeaseClauses || [];

/**
 * Loads the clause configuration UI for stage 6.
 * Uses units already selected in stage 2.
 * No lease agreement ID is needed - clauses are configured here and saved later.
 */
async function loadClausesForStage6() {
  const container = document.getElementById("clausesContainer");
  if (!container) return;

  if (
    container.children.length > 0 &&
    container.querySelector("#globalClauses")
  ) {
    //  Re-sync dates even if already loaded (respects user edits and
    //  lease-relative offsets - see _resyncClauseDates)
    _resyncClauseDates();

    return;
  }

  if (
    typeof choiceFieldMappings === "undefined" ||
    Object.keys(choiceFieldMappings).length === 0
  ) {
    container.innerHTML = `<div style="padding:20px;color:#6b7280;text-align:center;">\u23F3 Loading configuration, please wait...</div>`;
    try {
      await initializeChoiceFieldMappings();
      await loadCPITypesLookup();
      await loadChargeTypesLookup();
      if (typeof loadVatsLookup === "function") await loadVatsLookup();
      if (typeof loadCurrenciesLookup === "function")
        await loadCurrenciesLookup();
    } catch (e) {
      console.error("Error loading clause config:", e);
    }
  }

  container.innerHTML = "";

  window._clauseDocumentUnits = (units || []).map((u) => ({
    unitId: u.id || u.array_unitid || "",
    unitName: u.name || u.array_name || "Unit",
    safeId: (u.id || u.array_unitid || "").replace(/[^a-zA-Z0-9]/g, ""),
    clauses: [],
  }));

  const clauseBlock = document.createElement("div");
  clauseBlock.id = "globalClauses";
  container.appendChild(clauseBlock);

  DisplayAllClauseTypes("globalClauses", "");

  //  After rendering, sync dates from Stage 2
  setTimeout(() => {
    _resyncClauseDates();
  }, 200);
}

/**
 * Captures all clause data configured in stage 6.
 * Clauses are global (apply to all units) - no per-unit grouping.
 * Stores results into window.sessionLeaseClauses.
 */
async function captureStage6ClauseData() {
  // Use a single dummy unit entry so captureManualClauseData can work with no suffix
  if (typeof documentData === "undefined") window.documentData = {};
  documentData.units = [
    { unitId: "global", unitName: "All Units", safeId: "", clauses: [] },
  ];

  const clauses = await captureManualClauseData();
  window.sessionLeaseClauses = clauses;
  console.log(` Captured ${clauses.length} clause(s) from stage 6.`);
  return clauses;
}

/**
 * Saves all session clauses to Dataverse after the lease agreement is created.
 * Each clause is saved once per unit (clauses apply to all selected units).
 * @param {string} leaseAgreementId
 */
async function saveStage6Clauses(leaseAgreementId) {
  await captureStage6ClauseData();

  if (!window.sessionLeaseClauses || !window.sessionLeaseClauses.length) {
    console.log("i No clauses to save.");
    return;
  }

  const targetUnits =
    window._clauseDocumentUnits && window._clauseDocumentUnits.length
      ? window._clauseDocumentUnits
      : [{ unitId: null, unitName: "All Units" }];

  console.log(
    ` Saving ${window.sessionLeaseClauses.length} clause(s) across ${targetUnits.length} unit(s)...`,
  );

  for (const clause of window.sessionLeaseClauses) {
    console.log(` Processing clause type: "${clause.clauseType}"`, {
      hasStepRentInstances: !!(
        clause.stepRentInstances && clause.stepRentInstances.length
      ),
      hasCPIInstances: !!(clause.cpiInstances && clause.cpiInstances.length),
      hasTurnoverInstances: !!(
        clause.turnoverInstances && clause.turnoverInstances.length
      ),
      stepRentCount: clause.stepRentInstances
        ? clause.stepRentInstances.length
        : 0,
      cpiCount: clause.cpiInstances ? clause.cpiInstances.length : 0,
      turnoverCount: clause.turnoverInstances
        ? clause.turnoverInstances.length
        : 0,
    });

    for (const unit of targetUnits) {
      try {
        if (clause.stepRentInstances && clause.stepRentInstances.length > 0) {
          console.log(
            `&#x1F4CB; Saving ${clause.stepRentInstances.length} Step Rent instance(s) for unit ${unit.unitName}`,
          );
          for (const instance of clause.stepRentInstances) {
            const merged = {
              clauseType: clause.clauseType,
              effectiveDate: instance.effectiveDate || clause.effectiveDate,
              expiryDate: instance.expiryDate || clause.expiryDate,
              description: instance.clauseSummary || clause.description || "",
              clauseSummary: instance.clauseSummary || "",
              stepRentEnabled: true,
              chargeTypeStepIncrease: instance.chargeTypeStepIncrease,
              increaseType: instance.increaseType,
              flatAmount: instance.flatAmount,
              stepRentPercentage: instance.stepRentPercentage,
              stepRentFrequency: instance.stepRentFrequency,
              enableCustomStepRentSchedule:
                instance.enableCustomStepRentSchedule,
              stepRentCycleStartDate: instance.stepRentCycleStartDate,
              stepRentCycleEndDate: instance.stepRentCycleEndDate,
            };
            console.log(" Step Rent merged object:", merged);
            await createLeaseClauseRecord(
              leaseAgreementId,
              unit.unitId,
              merged,
            );
          }
        } else if (clause.cpiInstances && clause.cpiInstances.length > 0) {
          console.log(
            `&#x1F4CB; Saving ${clause.cpiInstances.length} CPI instance(s) for unit ${unit.unitName}`,
          );
          for (const instance of clause.cpiInstances) {
            const merged = {
              clauseType: clause.clauseType,
              effectiveDate: instance.effectiveDate || clause.effectiveDate,
              expiryDate: instance.expiryDate || clause.expiryDate,
              description: instance.clauseSummary || clause.description || "",
              clauseSummary: instance.clauseSummary || "",
              indexationEnabled: true,
              currentIndex: instance.currentIndex,
              initialWaitingPeriod: instance.initialWaitingPeriod,
              chargeTypeCPI: instance.chargeTypeCPI,
              increaseTypeCPI: instance.increaseTypeCPI,
              flatAmountCPI: instance.flatAmountCPI,
              // FIX: Was "minimumIncreaseAmountCPI" - now matches capture and createLeaseClauseRecord
              minimumIncreaseFlatAmountCPI:
                instance.minimumIncreaseFlatAmountCPI,
              minimumIncreasePercentage: instance.minimumIncreasePercentage,
              maximumIncreasePercentage: instance.maximumIncreasePercentage,
              minimumTimeInterval: instance.minimumTimeInterval,
              triggerValue: instance.triggerValue,
              cpiType: instance.cpiType,
              cpiRentFrequency: instance.cpiRentFrequency,
              cpiReferenceMonth: instance.cpiReferenceMonth,
              cpiCustomMonth: instance.cpiCustomMonth,
              skipFirstCPISchedule: instance.skipFirstCPISchedule,
              enableCustomCPISchedule: instance.enableCustomCPISchedule,
              cpiScheduleStartDate: instance.cpiScheduleStartDate,
              cpiScheduleEndDate: instance.cpiScheduleEndDate,
            };
            console.log(" CPI merged object:", merged);
            await createLeaseClauseRecord(
              leaseAgreementId,
              unit.unitId,
              merged,
            );
          }
        } else if (
          clause.turnoverInstances &&
          clause.turnoverInstances.length > 0
        ) {
          console.log(
            `&#x1F4CB; Saving ${clause.turnoverInstances.length} Turnover Rent instance(s) for unit ${unit.unitName}`,
          );
          for (const instance of clause.turnoverInstances) {
            const merged = {
              clauseType: clause.clauseType,
              effectiveDate: instance.effectiveDate || clause.effectiveDate,
              expiryDate: instance.expiryDate || clause.expiryDate,
              description: instance.clauseSummary || clause.description || "",
              clauseSummary: instance.clauseSummary || "",
              turnoverRentEnabled: true,
              subjectToVAT: instance.subjectToVAT,
              vat: instance.vat,
              taxIncluded: instance.taxIncluded,
              enableOCR: instance.enableOCR,
              enableProration: instance.enableProration,
              turnoverRentBasis: instance.turnoverRentBasis,
              currency: instance.currency,
              salesThreshold: instance.salesThreshold,
              chargeTypeTurnover: instance.chargeTypeTurnover,
              secondaryChargeTypeTurnover: instance.secondaryChargeTypeTurnover,
              settlementCycle: instance.settlementCycle,
              enableCustomTurnoverSchedule:
                instance.enableCustomTurnoverSchedule,
              turnoverCycleStartDate: instance.turnoverCycleStartDate,
              turnoverCycleEndDate: instance.turnoverCycleEndDate,
              reportingCycle: instance.reportingCycle,
              turnoverRentCalculationType: instance.turnoverRentCalculationType,
              increaseTypeTurnover: instance.increaseTypeTurnover,
              flatAmountTurnoverRent: instance.flatAmountTurnoverRent,
              minSalesRentAmount: instance.minSalesRentAmount,
              turnoverRate: instance.turnoverRate,
              minimumTurnoverPercentage: instance.minimumTurnoverPercentage,
            };
            console.log(" Turnover Rent merged object:", merged);
            await createLeaseClauseRecord(
              leaseAgreementId,
              unit.unitId,
              merged,
            );
          }
        } else {
          console.log(
            `&#x1F4CB; Saving simple clause "${clause.clauseType}" for unit ${unit.unitName}`,
          );
          await createLeaseClauseRecord(leaseAgreementId, unit.unitId, clause);
        }
        console.log(
          ` Clause saved: ${clause.clauseType} for unit ${unit.unitName}`,
        );
      } catch (err) {
        console.error(
          ` Failed to save clause "${clause.clauseType}" for unit ${unit.unitName}:`,
          err,
        );
      }
    }
  }
}

//======================================================================================
// HELPER: DATE CONVERTER (DD-MM-YYYY -> ISO) - required by createLeaseClauseRecord
//======================================================================================
function convertToISODate(dateString) {
  if (!dateString || dateString.trim() === "") return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(dateString)) {
    const date = new Date(dateString);
    return !isNaN(date.getTime()) ? date.toISOString() : null;
  }
  const parts = dateString.split("-");
  if (parts.length === 3) {
    const day = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1;
    const year = parseInt(parts[2], 10);
    const date = new Date(year, month, day);
    if (!isNaN(date.getTime())) return date.toISOString();
  }
  console.warn(`Invalid date format: "${dateString}"`);
  return null;
}

// Create Tenant and Signatory records on draft save
async function createTenantAndSignatory(leaseId) {
  let tenantId = document.getElementById("tenantId").value;
  const tenantType = document.getElementById("tenantType").value;
  const tenantName = document.getElementById("tenantDisplay").value;

  if (!tenantId || !tenantType) {
    console.warn("No tenant - skipping");
    return;
  }

  tenantId = tenantId.replace(/[{}]/g, "");

  try {
    const payload = {
      "array_LeaseAgreement@odata.bind": `/array_leaseagreements(${leaseId})`,
      array_signaturestatus: 126330002,
      array_role: 126330000,
    };

    //  Set the name field to match the tenant's display name
    if (tenantName && tenantName.trim() !== "") {
      payload["array_tenantsandsignatoriesname"] = tenantName.trim();
    }

    //  Using schema name for polymorphic lookup
    if (tenantType === "account") {
      payload["array_ContactorAccount_account@odata.bind"] =
        `/accounts(${tenantId})`;
    } else if (tenantType === "contact") {
      payload["array_ContactorAccount_contact@odata.bind"] =
        `/contacts(${tenantId})`;
    }

    //  Fetch and set email from the contact/account record
    try {
      if (tenantType === "account") {
        const accRec = await XrmContext.WebApi.retrieveRecord(
          "account",
          tenantId,
          "?$select=emailaddress1",
        );
        if (accRec && accRec.emailaddress1) {
          payload["array_email"] = accRec.emailaddress1;
          console.log(" Account email fetched:", accRec.emailaddress1);
        }
      } else if (tenantType === "contact") {
        const conRec = await XrmContext.WebApi.retrieveRecord(
          "contact",
          tenantId,
          "?$select=emailaddress1",
        );
        if (conRec && conRec.emailaddress1) {
          payload["array_email"] = conRec.emailaddress1;
          console.log(" Contact email fetched:", conRec.emailaddress1);
        }
      }
    } catch (emailErr) {
      console.warn("  Could not fetch tenant email:", emailErr);
    }

    console.log(" PAYLOAD:", payload);

    const result = await XrmContext.WebApi.createRecord(
      "array_tenantsandsignatories",
      payload,
    );

    console.log(" SUCCESS:", result);
  } catch (error) {
    console.error(" ERROR:", error);
  }
}

async function getEnvVarValue(schemaName) {
  const defResult = await XrmContext.WebApi.retrieveMultipleRecords(
    "environmentvariabledefinition",
    `?$select=environmentvariabledefinitionid&$filter=schemaname eq '${schemaName}'&$top=1`,
  );
  const defId = defResult.entities[0]?.environmentvariabledefinitionid;
  if (!defId)
    throw new Error(`Environment variable '${schemaName}' not found.`);
  const valResult = await XrmContext.WebApi.retrieveMultipleRecords(
    "environmentvariablevalue",
    `?$select=value&$filter=_environmentvariabledefinitionid_value eq ${defId}&$top=1`,
  );
  const val = valResult.entities[0]?.value;
  if (!val)
    throw new Error(`Environment variable '${schemaName}' has no value.`);
  return val.trim();
}

async function createCollateralRecords(leaseAgreementId) {
  const rentChargeTypeId = await getEnvVarValue("array_RentChargeTypeGUID");
  const serviceChargeTypeId = await getEnvVarValue(
    "array_ServiceChargeChargeTypeGUID",
  );

  const rentRuleResult = await XrmContext.WebApi.createRecord(
    "array_collateralcalculationrule",
    {
      "array_ChargeType@odata.bind": `/array_chargetypes(${rentChargeTypeId})`,
      array_coefficient: 3,
      "array_LeaseAgreement@odata.bind": `/array_leaseagreements(${leaseAgreementId})`,
    },
  );

  const serviceRuleResult = await XrmContext.WebApi.createRecord(
    "array_collateralcalculationrule",
    {
      "array_ChargeType@odata.bind": `/array_chargetypes(${serviceChargeTypeId})`,
      array_coefficient: 3,
      "array_LeaseAgreement@odata.bind": `/array_leaseagreements(${leaseAgreementId})`,
    },
  );

  await XrmContext.WebApi.createRecord("array_collateralconfiguration", {
    "array_Rule@odata.bind": `/array_collateralcalculationrules(${rentRuleResult.id})`,
    array_type: 126330007,
  });

  await XrmContext.WebApi.createRecord("array_collateralconfiguration", {
    "array_Rule@odata.bind": `/array_collateralcalculationrules(${serviceRuleResult.id})`,
    array_type: 126330007,
  });

  console.log(" Collateral records created successfully.");
}

async function saveAndClose() {
  if (!validateForm()) return;

  try {
    window.allowNavigation = true;
    window.onbeforeunload = null;
    if (window.parent) window.parent.onbeforeunload = null;

    disableAllInteractions();
    showLoadingOverlay(" Saving lease agreement...");

    const leaseAgreementId = await createLeaseAgreement(); // creates as In Progress
    if (!leaseAgreementId) throw new Error("Lease Agreement not created.");

    showLoadingOverlay(" Creating recurring charges...");
    await createRecurringCharges(
      leaseAgreementId,
      document.getElementById("tenantId").value,
      document.getElementById("tenantType").value,
    );

    // Fire the batch invoice generation flow once per lease save. Must run
    // BEFORE the webhook flow's 30s debounce elapses to pre-empt its
    // per-charge runs. All RCs are already created at this point because
    // createRecurringCharges above awaits each one sequentially.
    showLoadingOverlay(" Generating invoices...");
    await triggerBatchInvoiceGeneration();

    showLoadingOverlay(" Creating deposits...");
    await createDeposits(
      leaseAgreementId,
      document.getElementById("tenantId").value,
      document.getElementById("tenantType").value,
    );

    showLoadingOverlay(" Updating units...");
    await updateUnitsWithLease(leaseAgreementId);

    showLoadingOverlay(" Saving lease options...");
    await saveLeaseOptions(leaseAgreementId);

    showLoadingOverlay(" Creating discounts...");
    await createDiscounts(leaseAgreementId);

    showLoadingOverlay(" Saving lease clauses...");
    await saveStage6Clauses(leaseAgreementId);

    showLoadingOverlay(" Creating tenant and signatory records...");
    await createTenantAndSignatory(leaseAgreementId);

    // Update lease status to Active / Draft
    showLoadingOverlay(" Finalizing lease status...");
    await updateLeaseStatusToDraft(leaseAgreementId);

    // Create lease history for Draft
    showLoadingOverlay(" Creating lease history...");
    await createLeaseHistoryRecord(leaseAgreementId);

    // Create collateral records
    showLoadingOverlay(" Creating collateral records...");
    await saveCollateralData(leaseAgreementId);

    // Save as Draft also saves the uploaded document to SharePoint (if any).
    if (window._autofillDocument) {
      showLoadingOverlay(" Saving document to SharePoint...");
      await saveLeaseDocumentToSharePoint(
        leaseAgreementId,
        window._autofillDocument,
      );
      window._autofillDocument = null; // consumed
    }

    hideLoadingOverlay();
    enableAllInteractions();

    showRedirectConfirmation(leaseAgreementId);
  } catch (error) {
    hideLoadingOverlay();
    enableAllInteractions();
    window.allowNavigation = false;
    console.error(" Error in saveAndClose:", error);
    showNotification(" " + (error.message || "Unknown error"), "error");
  }
}

async function createLeaseHistoryRecord(leaseAgreementId) {
  try {
    const leaseName =
      document.getElementById("leaseName").value || "Unknown Lease";
    const tenantName =
      document.getElementById("tenantDisplay").value || "Unknown Tenant";

    const today = new Date();
    const dd = String(today.getDate()).padStart(2, "0");
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const yyyy = today.getFullYear();
    const formattedDate = `${dd}/${mm}/${yyyy}`;

    const description = `Lease agreement "${leaseName}" for tenant ${tenantName} was created as a draft on ${formattedDate}.`;

    const record = {};
    record["array_LeaseAgreement@odata.bind"] =
      `/array_leaseagreements(${leaseAgreementId})`;
    record["array_historytype"] = 126330004;
    record["array_lifecyclestatus"] = 126330001; // Draft
    record["array_statuschangedate"] = today.toISOString();
    record["array_description"] = description;
    record["array_shortdescription"] = "Lease Draft";

    const result = await XrmContext.WebApi.createRecord(
      "array_leasehistory",
      record,
    );
    console.log(" Lease history record created:", result.id);
    return result;
  } catch (error) {
    console.error(" Error creating lease history record:", error);
  }
}

// Send For Signing
async function sendForSigning() {
  if (!validateForm()) return;

  try {
    removeAllNavigationBlockers();
    disableAllInteractions();
    showLoadingOverlay(" Saving lease agreement...");

    const leaseAgreementId = await createLeaseAgreement(); // creates as In Progress
    if (!leaseAgreementId) throw new Error("Lease Agreement not created.");

    showLoadingOverlay(" Creating recurring charges...");
    await createRecurringCharges(
      leaseAgreementId,
      document.getElementById("tenantId").value,
      document.getElementById("tenantType").value,
    );

    // Fire the batch invoice generation flow once per lease save. Must run
    // BEFORE the webhook flow's 30s debounce elapses to pre-empt its
    // per-charge runs. All RCs are already created at this point because
    // createRecurringCharges above awaits each one sequentially.
    showLoadingOverlay(" Generating invoices...");
    await triggerBatchInvoiceGeneration();

    showLoadingOverlay(" Creating deposits...");
    await createDeposits(
      leaseAgreementId,
      document.getElementById("tenantId").value,
      document.getElementById("tenantType").value,
    );

    showLoadingOverlay(" Updating units...");
    await updateUnitsWithLease(leaseAgreementId);

    showLoadingOverlay(" Saving lease options...");
    await saveLeaseOptions(leaseAgreementId);

    showLoadingOverlay(" Creating discounts...");
    await createDiscounts(leaseAgreementId);

    showLoadingOverlay(" Saving Financial Clauses ...");
    await saveStage6Clauses(leaseAgreementId);

    showLoadingOverlay(" Creating tenant and signatory records...");
    await createTenantAndSignatory(leaseAgreementId);

    // Collateral records are created for both paths.
    showLoadingOverlay(" Creating collateral records...");
    await saveCollateralData(leaseAgreementId);

    // Save the uploaded document to SharePoint (only when one was uploaded).
    if (window._autofillDocument) {
      showLoadingOverlay(" Saving document to SharePoint...");
      await saveLeaseDocumentToSharePoint(
        leaseAgreementId,
        window._autofillDocument,
      );
      window._autofillDocument = null; // consumed
    }

    // Activate the lease directly. The signing widget is NEVER opened -
    // activation happens whether or not a document was uploaded.
    showLoadingOverlay(" Activating lease...");
    await activateLeaseFromUpload(leaseAgreementId);

    showLoadingOverlay(" Creating lease history...");
    await createSignedLeaseHistory(leaseAgreementId);

    hideLoadingOverlay();
    enableAllInteractions();
    closeCreationDialog(leaseAgreementId);
  } catch (error) {
    hideLoadingOverlay();
    enableAllInteractions();
    console.error(" Error in sendForSigning:", error);
    showNotification(" Error: " + (error.message || "Unknown error"), "error");
  }
}

// ==========================================================================
//  AI-UPLOAD PATH HELPERS
//  When a document is uploaded for AI autofill, the lease is activated
//  directly from this widget (the signing widget is skipped). These mirror
//  array_SigningScript.js -> saveAndComplete().
// ==========================================================================

// Env var holding the HTTP-trigger URL of the SharePoint folder + save flow.
const SAVE_LEASE_DOC_FLOW_ENV_VAR = "array_SaveLeaseDocumentToSharePoint";

// Save the uploaded document to the lease's SharePoint folder via the flow.
// The flow creates the folder hierarchy (mirroring the Lease Agreement
// Location Creation flow) and uploads the file, returning the SharePoint URL.
async function saveLeaseDocumentToSharePoint(leaseAgreementId, docData) {
  if (!docData || !docData.fileContent) {
    console.warn(" No uploaded document to save to SharePoint; skipping.");
    return;
  }
  const cleanLeaseId = leaseAgreementId.replace(/[{}]/g, "");
  const flowUrl = await getEnvVarValue(SAVE_LEASE_DOC_FLOW_ENV_VAR);

  const payload = {
    leaseAgreementId: cleanLeaseId,
    fileName: docData.fileName || "Lease Agreement.pdf",
    fileContent: docData.fileContent,
    fileType: docData.fileType || "application/pdf",
    documentType: "Signed",
  };

  const response = await fetch(flowUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    let errTxt = "";
    try {
      errTxt = await response.text();
    } catch (e) {}
    throw new Error(
      `SharePoint save failed (HTTP ${response.status}): ${errTxt}`,
    );
  }

  // Best-effort: store the returned SharePoint URL on the lease.
  try {
    const raw = await response.text();
    const result = raw && raw.trim() ? JSON.parse(raw) : {};
    const spUrl = result.sharePointUrl || result.SharePointUrl || "";
    if (spUrl) {
      await XrmContext.WebApi.updateRecord(
        "array_leaseagreement",
        cleanLeaseId,
        { array_documenturl: spUrl },
      );
    }
  } catch (e) {
    console.warn(" Could not parse/store SharePoint URL:", e);
  }
  console.log(" Document saved to SharePoint for lease:", cleanLeaseId);
}

// Activate the lease directly (mirrors saveAndComplete status logic).
async function activateLeaseFromUpload(leaseAgreementId) {
  const cleanLeaseId = leaseAgreementId.replace(/[{}]/g, "");

  let statusCode = 1; // Active
  try {
    const leaseRec = await XrmContext.WebApi.retrieveRecord(
      "array_leaseagreement",
      cleanLeaseId,
      "?$select=array_leasestartdate",
    );
    if (leaseRec && leaseRec.array_leasestartdate) {
      const startDate = new Date(leaseRec.array_leasestartdate);
      const today = new Date();
      startDate.setHours(0, 0, 0, 0);
      today.setHours(0, 0, 0, 0);
      if (startDate > today) statusCode = 126330003; // Future
    }
  } catch (e) {
    console.warn(" Could not read lease start date; defaulting to Active:", e);
  }

  await XrmContext.WebApi.updateRecord("array_leaseagreement", cleanLeaseId, {
    statecode: 0,
    statuscode: statusCode,
    array_docusignstatus: 126330007,
    array_leaseexecutiondate: new Date().toISOString(),
  });
  console.log(
    " Lease activated (statuscode " + statusCode + "):",
    cleanLeaseId,
  );
}

// Create the "Lease Signed" history record (mirrors saveAndComplete).
async function createSignedLeaseHistory(leaseAgreementId) {
  try {
    const cleanLeaseId = leaseAgreementId.replace(/[{}]/g, "");
    const leaseName =
      document.getElementById("leaseName")?.value || "Lease Agreement";

    const tenantNamesSet = new Set();
    const primaryTenant = document.getElementById("tenantDisplay")?.value || "";
    if (primaryTenant.trim()) tenantNamesSet.add(primaryTenant.trim());
    try {
      const tenantsResult = await XrmContext.WebApi.retrieveMultipleRecords(
        "array_tenantsandsignatories",
        `?$select=array_tenantsandsignatoriesname&$filter=_array_leaseagreement_value eq ${cleanLeaseId}`,
      );
      (tenantsResult.entities || []).forEach((e) => {
        const n = e["array_tenantsandsignatoriesname"];
        if (n && n.trim()) tenantNamesSet.add(n.trim());
      });
    } catch (e) {
      console.warn(" Could not fetch signatory names:", e);
    }
    const tenantNamesList =
      tenantNamesSet.size > 0
        ? [...tenantNamesSet].join(", ")
        : "Unknown Tenant";

    const signedDate = new Date().toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
    const description = `Lease agreement "${leaseName}" was signed on ${signedDate} by tenant ${tenantNamesList}.`;

    await XrmContext.WebApi.createRecord("array_leasehistory", {
      "array_LeaseAgreement@odata.bind": `/array_leaseagreements(${cleanLeaseId})`,
      array_historytype: 126330005,
      array_signingstatuschange: 126330002,
      array_statuschangedate: new Date().toISOString(),
      array_description: description,
      array_shortdescription: "Lease Signed",
    });
    console.log(" Signed lease history created:", description);
  } catch (error) {
    console.error(" Error creating signed lease history:", error);
  }
}

// Close the creation dialog and navigate to the newly-activated lease record.
function closeCreationDialog(leaseAgreementId) {
  try {
    const parentXrm = window.parent?.Xrm || window.Xrm;
    const cleanLeaseId = leaseAgreementId.replace(/[{}]/g, "");
    removeAllNavigationBlockers();
    clearDynamicsNavigationGuards();
    if (parentXrm?.Navigation?.navigateTo) {
      parentXrm.Navigation.navigateTo(
        {
          pageType: "entityrecord",
          entityName: "array_leaseagreement",
          entityId: cleanLeaseId,
        },
        { target: 1 },
      ).catch((e) => console.warn(" navigateTo failed:", e));
    }
    try {
      parentXrm?.Navigation?.closeDialog?.();
    } catch (e) {}
    try {
      window.close();
    } catch (e) {}
  } catch (error) {
    console.error(" Error closing creation dialog:", error);
  }
}

// New helper: update lease to Active statecode / Draft statuscode after all records saved
async function updateLeaseStatusToDraft(leaseAgreementId) {
  try {
    await XrmContext.WebApi.updateRecord(
      "array_leaseagreement",
      leaseAgreementId,
      {
        statecode: 0, // Active
        statuscode: 126330001, // Draft
      },
    );
    console.log(" Lease status updated to Active / Draft");
  } catch (error) {
    console.error(" Error updating lease status to Draft:", error);
    throw error;
  }
}

async function closeAndOpenSigningUI(leaseAgreementId) {
  try {
    console.log(" Opening signing UI and closing current dialog...");

    const parentXrm = window.parent?.Xrm || window.Xrm;

    if (!parentXrm || !parentXrm.Navigation) {
      throw new Error("Xrm.Navigation not available");
    }

    const cleanLeaseId = leaseAgreementId.replace(/[{}]/g, "");

    removeAllNavigationBlockers();
    clearDynamicsNavigationGuards();

    const pageInput = {
      pageType: "webresource",
      webresourceName: "array_SigningWidget",
      data: JSON.stringify({
        recordId: cleanLeaseId,
        entityName: "array_leaseagreement",
        source: "draft",
      }),
    };

    const navigationOptions = {
      target: 2,
      width: 900,
      height: 750,
      position: 1,
      title: " ",
    };

    // -- Fire BOTH operations simultaneously - no await before close ----------
    // navigateTo and close are fired together; no sequential delay between them.
    parentXrm.Navigation.navigateTo(pageInput, navigationOptions).catch(
      (navError) => {
        console.error(" navigateTo failed:", navError);
        parentXrm.Navigation.openAlertDialog({
          text: `Lease created!\n\nLease ID: ${cleanLeaseId}\n\nPlease open the lease record to proceed with signing.`,
          title: "Lease Created",
        }).catch(() => alert(`Lease created! ID: ${cleanLeaseId}`));
      },
    );

    // -- Close immediately - no delay ------------------------------------------
    try {
      parentXrm.Navigation.closeDialog();
    } catch (e) {
      console.warn("  closeDialog() failed:", e.message);
    }

    try {
      window.close();
    } catch (e) {
      console.warn("  window.close() failed:", e.message);
    }
  } catch (error) {
    console.error(" Error in closeAndOpenSigningUI:", error);

    const msg = `Lease agreement created!\nLease ID: ${leaseAgreementId}\n\nPlease open the lease record to proceed with signing.`;
    try {
      const parentXrm = window.parent?.Xrm || window.Xrm;
      if (parentXrm?.Navigation?.openAlertDialog) {
        await parentXrm.Navigation.openAlertDialog({
          text: msg,
          title: "Lease Created",
        });
      } else {
        alert(msg);
      }
    } catch (e) {
      alert(msg);
    }

    try {
      window.close();
    } catch (e) {}
  }
}

// CLose Only -  WITH CONFIRMATION
function closeOnly() {
  // Show confirmation popup instead of closing immediately
  showCloseConfirmation();
}

// Show close confirmation popup
function showCloseConfirmation() {
  const modal = document.getElementById("closeConfirmModal");
  if (!modal) {
    console.error(" Close confirmation modal not found!");
    return;
  }
  console.log(" Opening close confirmation modal");
  modal.classList.add("active");
  document.body.style.overflow = "hidden";
}

// Close the confirmation popup (No button)
function closeCloseConfirm() {
  const modal = document.getElementById("closeConfirmModal");
  if (!modal) return;

  console.log(" Closing close confirmation modal...");

  // Remove modal from view
  modal.classList.remove("active");
  document.body.style.overflow = "auto";
}

// Confirm close action (Yes button)
function confirmClose() {
  // Close confirmation modal
  const modal = document.getElementById("closeConfirmModal");
  if (modal) {
    modal.classList.remove("active");
    document.body.style.overflow = "auto";
  }

  removeAllNavigationBlockers();

  // Proper dialog close
  if (window.parent?.Xrm?.Navigation?.close) {
    window.parent.Xrm.Navigation.close();
    return;
  }

  // fallback
  window.close();
}

// Cancel form - closes dialog without confirmation
function cancelForm() {
  // Remove ALL navigation blockers
  removeAllNavigationBlockers();

  // Close dialog directly
  closeDialogSilently();
}

// Helper function to create lease agreement and return its ID
async function createLeaseAgreement() {
  return new Promise((resolve, reject) => {
    const leaseRecord = {};
    leaseRecord.array_leasename = document.getElementById("leaseName").value;
    leaseRecord.array_leasetype = parseInt(
      document.getElementById("leaseType").value,
    );

    const leaseTermTypeValue = document.getElementById("leaseTermType").value;
    if (leaseTermTypeValue) {
      leaseRecord.array_leasetermtype = parseInt(leaseTermTypeValue);
    }

    leaseRecord.array_leasestartdate =
      document.getElementById("startDate").value;

    const endDate = document.getElementById("endDate").value;
    if (endDate && endDate.trim() !== "") {
      leaseRecord.array_leaseenddate = endDate;
    }

    const leaseTerm = document.getElementById("leaseTerm").value;
    if (leaseTerm && leaseTerm.trim() !== "") {
      leaseRecord.array_leasetermmonths = parseInt(leaseTerm);
    }

    const moveInDateEl = document.getElementById("moveInDate");
    const moveInDate = moveInDateEl ? moveInDateEl.value : "";
    if (moveInDate && moveInDate.trim() !== "") {
      leaseRecord.array_moveindate = moveInDate;
    }

    const description = document.getElementById("description").value;
    if (description) {
      leaseRecord.array_description = description;
    }

    leaseRecord.array_totalareaofunits = totalUnitsAreaValue;

    const brandNameId =
      (document.getElementById("brandNameId") || {}).value || "";
    if (
      brandNameId &&
      brandNameId.trim() !== "" &&
      brandNameId.trim().length === 36
    ) {
      leaseRecord["array_Brand@odata.bind"] =
        "/array_brandnames(" + brandNameId.trim() + ")";
    }

    leaseRecord.array_docusignstatus = 126330003; // Not Sent

    //  CHANGED: Create initially as Active / In Progress
    leaseRecord.statecode = 0; // Active
    leaseRecord.statuscode = 126330004; // In Progress

    const propertyManagerId =
      (document.getElementById("propertyManagerId") || {}).value || "";
    if (propertyManagerId && propertyManagerId.trim() !== "") {
      leaseRecord["ownerid@odata.bind"] =
        "/systemusers(" + propertyManagerId.trim() + ")";
    }

    const tenantId = document.getElementById("tenantId").value;
    const tenantType = document.getElementById("tenantType").value;
    if (tenantId && tenantType) {
      if (tenantType === "account") {
        leaseRecord["array_Tenant_account@odata.bind"] =
          "/accounts(" + tenantId + ")";
      } else if (tenantType === "contact") {
        leaseRecord["array_Tenant_contact@odata.bind"] =
          "/contacts(" + tenantId + ")";
      }
    }

    const propertyId = document.getElementById("propertyId").value;
    leaseRecord["array_Property@odata.bind"] =
      "/array_properties(" + propertyId + ")";

    if (units.length > 0) {
      const buildingIds = [
        ...new Set(
          units
            .map((u) => (u.buildingId || "").trim())
            .filter((id) => id !== ""),
        ),
      ];
      if (buildingIds.length === 1) {
        leaseRecord["array_Building@odata.bind"] =
          "/array_buildings(" + buildingIds[0] + ")";
      }
    }

    const contactId = (document.getElementById("contactId") || {}).value || "";
    if (
      contactId &&
      contactId.trim() !== "" &&
      contactId.trim().length === 36
    ) {
      leaseRecord["array_PrimaryContact@odata.bind"] =
        "/contacts(" + contactId.trim() + ")";
    }

    XrmContext.WebApi.createRecord("array_leaseagreement", leaseRecord).then(
      async function success(result) {
        try {
          const leaseAgreementId = result.id.replace(/[{}]/g, "");
          console.log(" Lease created (In Progress):", leaseAgreementId);

          await saveLeaseUnitAssociations(leaseAgreementId);

          showNotification("Lease agreement created successfully", "success");
          resolve(leaseAgreementId);
        } catch (error) {
          console.error(" Error in unit associations:", error);
          reject(error);
        }
      },
      function error(err) {
        console.error(" Error saving lease:", err);
        showNotification("Error creating lease: " + err.message, "error");
        reject(err);
      },
    );
  });
}

//-------------------------------------------------------------------------Stage -5.2 -- CONFIRMATION & REDIRECT FUNCTIONS  --------------------------------------------------------------------//

// Show redirect confirmation popup
function showRedirectConfirmation(leaseAgreementId) {
  // Create modal HTML
  const modalHTML = `
            <div class="modal active" id="redirectConfirmModal" style="z-index: 100000;">
                <div class="modal-content" style="max-width: 500px;">
                    <div class="modal-header" style="background: linear-gradient(135deg, #48bb78 0%, #38a169 100%); color: white; border-radius: 16px 16px 0 0;">
                        <h3 class="modal-title" style="color: white; display: flex; align-items: center; gap: 10px;">
                            <span style="font-size: 28px;"></span>
                            Lease Agreement Saved Successfully!
                        </h3>
                    </div>
                    <div class="modal-body" style="padding: 32px 24px;">
                        <p style="font-size: 15px; color: #2d3748; margin-bottom: 24px; line-height: 1.6;">
                            Your lease agreement has been created successfully.
                        </p>
                        <p style="font-size: 15px; color: #4a5568; font-weight: 600; margin-bottom: 12px;">
                            Would you like to open the newly created lease agreement form?
                        </p>
                        <div style="background: #f7fafc; padding: 16px; border-radius: 8px; border-left: 4px solid #667eea;">
                            <p style="font-size: 13px; color: #718096; margin: 0;">
                                * <strong>Yes</strong> - Opens the lease agreement form<br>
                                * <strong>No</strong> - Closes this window
                            </p>
                        </div>
                    </div>
                    <div class="modal-footer" style="gap: 12px; padding: 20px 24px;">
                        <button class="btn btn-secondary" onclick="closeWithoutRedirect()" style="flex: 1;">
                            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" style="margin-right: 6px;">
                                <path d="M15 5L5 15M5 5L15 15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                            </svg>
                            No, Close Window
                        </button>
                        <button class="btn btn-primary" onclick="redirectToForm('${leaseAgreementId}')" style="flex: 1;">
                            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" style="margin-right: 6px;">
                                <path d="M5 10L8.5 13.5L15 6.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                            Yes, Open Form
                        </button>
                    </div>
                </div>
            </div>
        `;

  // Add modal to body
  document.body.insertAdjacentHTML("beforeend", modalHTML);
  document.body.style.overflow = "hidden";
}

// Redirect to form
async function redirectToForm(leaseAgreementId) {
  try {
    // Close modal
    const modal = document.getElementById("redirectConfirmModal");
    if (modal) modal.remove();

    // Show loading
    showLoadingOverlay(" Opening Lease Agreement...");

    clearDynamicsNavigationGuards();
    await new Promise((res) => setTimeout(res, 400));

    // Get current environment + app context
    const orgUrl = window.parent.Xrm.Utility.getGlobalContext().getClientUrl();

    // Try to get current app id dynamically
    let appId = null;
    try {
      appId =
        await window.parent.Xrm.Utility.getGlobalContext().getCurrentAppId();
    } catch (e) {
      console.warn("  Couldn't fetch appId dynamically:", e.message);
    }

    // Construct target URL
    const redirectUrl = appId
      ? `${orgUrl}/main.aspx?appid=${appId}&pagetype=entityrecord&etn=array_leaseagreement&id=${leaseAgreementId}`
      : `${orgUrl}/main.aspx?pagetype=entityrecord&etn=array_leaseagreement&id=${leaseAgreementId}`;

    //  Redirect the parent frame (main tab)
    if (window.parent && window.parent !== window) {
      window.parent.onbeforeunload = null;
      window.parent.location.assign(redirectUrl);
    } else {
      window.location.assign(redirectUrl);
    }
  } catch (error) {
    hideLoadingOverlay();
    console.error(" Error redirecting:", error);
    showNotification(" Error opening form: " + error.message, "error");
  }
}

// Close without redirect
function closeWithoutRedirect() {
  showLoadingOverlay(" Closing...");
  // Close modal
  const modal = document.getElementById("redirectConfirmModal");
  if (modal) modal.remove();

  // Close the dialog window
  removeAllNavigationBlockers();
  closeDialogSilently();

  // Fallback: if dialog doesn't close, try window.close()
  setTimeout(() => {
    try {
      window.close();

      // If window.close() doesn't work, try parent
      if (window.parent && window.parent !== window) {
        window.parent.close();
      }
    } catch (e) {
      console.log("Could not close window:", e.message);
      // Last resort: refresh parent
      if (window.parent && window.parent.location) {
        window.parent.location.reload();
      }
    }
  }, 300);
}

//------------------------------------------------------------------------- RESET & DELETE CONFIRMATION   --------------------------------------------------------------------//

// Show reset confirmation popup
function showResetConfirmation() {
  showDeleteConfirm(
    "Reset Form",
    "Are you sure you want to reset this form? All entered data will be cleared and cannot be recovered.",
    () => {
      confirmReset();
    },
  );
}

// Confirm reset and clear all data
function confirmReset() {
  closeDeleteConfirm();

  // Form is now empty; a fresh upload shouldn't prompt for a reset. The re-upload
  // flow re-sets this to true once it finishes autofilling again.
  window._autofillHasRun = false;
  window._autofillDocument = null; // no uploaded document after a reset
  // Drop any deferred autofill data so it can't repopulate after a manual reset.
  window._pendingChargesAutofill = null;
  window._pendingSecurityAutofill = null;
  window._pendingOptionsAutofill = null;
  window._pendingClausesAutofill = null;
  window._pendingDiscountsAutofill = null;
  window._pendingCollateralAutofill = null;
  window._subAgentFlowState = "idle";
  // Invalidate any in-flight sub-agent run so its late response is ignored.
  window._subAgentRunId = (window._subAgentRunId || 0) + 1;
  if (typeof _showUnitNotFoundHint === "function") _showUnitNotFoundHint([]);
  window._autofillMainInFlight = false;

  recurringCharges = [];
  deposits = [];
  units = [];
  window.sessionLeaseOptions = [];
  chargesLoadedInitially = false;
  completedStages = [];
  if (typeof dismissSecurityAlternativeNotice === "function")
    dismissSecurityAlternativeNotice();
  lastSelectedTenantName = "";
  originalChargesFromDataverse = [];
  chargesToDelete = [];
  totalUnitsAreaValue = 0;
  currentStage = 1;
  maxVisitedStage = 1;

  document.querySelectorAll(".stage-content").forEach((stage) => {
    stage.classList.remove("active");
  });
  const stage1 = document.getElementById("stage1");
  if (stage1) stage1.classList.add("active");

  document.querySelectorAll(".stage-item").forEach((item) => {
    item.classList.remove("completed", "active");
  });
  const stage1Indicator = document.querySelector('.stage-item[data-stage="1"]');
  if (stage1Indicator) stage1Indicator.classList.add("active");
  updateStageLockStates();

  // -- Stage 1: Basic Information ----------------------------------------------
  const _s1fields = [
    "leaseName",
    "leaseType",
    "leaseTermType",
    "tenantId",
    "tenantType",
    "tenantDisplay",
    "contactId",
    "contactType",
    "contactDisplay",
    "propertyId",
    "propertyDisplay",
    "propertyManagerId",
    "propertyManagerType",
    "propertyManagerDisplay",
    "brandNameId",
    "brandNameDisplay",
    "description",
  ];
  _s1fields.forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.value = "";
      el.removeAttribute("data-user-input");
    }
  });

  // Hide ALL clear (x) buttons in Stage 1
  [
    "clearTenantBtn",
    "clearContactBtn",
    "clearPropertyBtn",
    "clearPropertyManagerBtn",
    "clearBrandNameBtn",
  ].forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) btn.style.display = "none";
  });

  // Hide auto-populated contact message
  const contactMsg = document.getElementById("contactAutoPopulatedMsg");
  if (contactMsg) contactMsg.style.display = "none";

  // Hide the character limit message
  const leaseNameLimit = document.getElementById("leaseNameLimitMsg");
  if (leaseNameLimit) leaseNameLimit.style.display = "none";

  // -- Stage 2: Contract Terms -------------------------------------------------
  ["startDate", "endDate", "leaseTerm", "moveInDate", "unitDisplay"].forEach(
    (id) => {
      const el = document.getElementById(id);
      if (el) {
        el.value = "";
        el.removeAttribute("data-user-input");
      }
    },
  );

  const unitsSection = document.getElementById("unitsSection");
  if (unitsSection) unitsSection.style.display = "none";

  renderUnits();

  const totalUnitsAreaGroup = document.getElementById("totalUnitsAreaGroup");
  if (totalUnitsAreaGroup) totalUnitsAreaGroup.style.display = "none";
  const totalUnitsAreaInput = document.getElementById("totalUnitsArea");
  if (totalUnitsAreaInput) totalUnitsAreaInput.value = "";

  // -- Stage 3: Recurring Charges ----------------------------------------------
  const chargesContainer = document.getElementById("allChargesContainer");
  if (chargesContainer) {
    chargesContainer.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">&#x1F4CB;</span>
        <p>No units added yet</p>
        <p class="empty-hint">Please add units in Stage 2 first</p>
      </div>`;
  }

  const _rcFields = [
    "chargeEditId",
    "chargeName",
    "chargeType",
    "chargeUnitSelect",
    "chargeStartDate",
    "chargeEndDate",
    "chargeFrequency",
    "chargePreFrequencyOffset",
    "chargeProrationEnabled",
    "chargeProrationEnabledFirstCycle",
    "chargeFrequencyStartDate",
    "chargeProrationEnabledLastCycle",
    "chargeInvoiceGenerationDate",
    "chargeDueDateRule",
    "chargeDueInDays",
    "chargeCurrency",
    "chargeAmount",
    "chargeTaxIncluded",
    "chargeBillableArea",
    "chargeVat",
    "chargeInvoiceSeparately",
    "chargeBankAccountDisplay",
    "chargeBankAccount",
    "chargeRateRuleDisplay",
    "chargeRateRule",
    "chargeExchangeRateDay",
    "chargeInvoicePrefix",
    "chargeInvoicePrefixDisplay",
  ];
  _rcFields.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });

  ["clearBankAccountBtn", "clearRateRuleBtn"].forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) btn.style.display = "none";
  });

  const prorationConditional = document.getElementById(
    "prorationConditionalFields",
  );
  if (prorationConditional) prorationConditional.style.display = "none";
  const firstCycleEndGroup = document.getElementById(
    "firstCycleFrequencyEndDateGroup",
  );
  if (firstCycleEndGroup) firstCycleEndGroup.style.display = "none";
  const exchangeRateDayGroup = document.getElementById("exchangeRateDayGroup");
  if (exchangeRateDayGroup) exchangeRateDayGroup.style.display = "none";
  const invoiceDatePreview = document.getElementById(
    "invoiceDatePreviewContainer",
  );
  if (invoiceDatePreview) invoiceDatePreview.style.display = "none";

  const rcModalTitle = document.getElementById("recurringModalTitle");
  if (rcModalTitle) rcModalTitle.textContent = "Add Recurring Charge";

  // -- Stage 4: Security & Insurance -------------------------------------------
  const depositsContainer = document.getElementById("allDepositsContainer");
  if (depositsContainer) {
    depositsContainer.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">&#x1F4B0;</span>
        <p>No records added yet</p>
        <p class="empty-hint">Click "Add" button above to create security & insurance records</p>
      </div>`;
  }

  const _depositFields = [
    "depositEditId",
    "depositTenantId",
    "depositTenantType",
    "depositUnitSelect",
    "depositCollateralType",
    "depositAmount",
    "depositCurrency",
    "depositBankDisplay",
    "depositBankId",
    "depositAmountNonDeposit",
    "depositCurrencyNonDeposit",
    "depositAmountDelivered",
    "depositAmountDeliveredCurrency",
    "depositIssuerDisplay",
    "depositIssuerId",
    "depositCollateralApproved",
    "depositDueDate",
    "depositPayments",
  ];
  _depositFields.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });

  ["clearDepositBankBtn", "clearDepositIssuerBtn"].forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) btn.style.display = "none";
  });

  const depositModalTitle = document.getElementById("depositModalTitle");
  if (depositModalTitle)
    depositModalTitle.textContent = "Quick Create: Deposit";
  const depositOnlyFields = document.getElementById("depositOnlyFields");
  if (depositOnlyFields) depositOnlyFields.style.display = "";
  const nonDepositFields = document.getElementById("nonDepositFields");
  if (nonDepositFields) nonDepositFields.style.display = "none";
  const depositSuggestionBox = document.getElementById("depositSuggestionBox");
  if (depositSuggestionBox) {
    depositSuggestionBox.style.display = "none";
    depositSuggestionBox.innerHTML = "";
  }

  // -- Stage 5: Lease Options --------------------------------------------------
  const optionsGrid = document.getElementById("optionsGrid");
  if (optionsGrid && optionsGrid.tBodies[0])
    optionsGrid.tBodies[0].innerHTML = "";
  clearOptionModalForm();
  const optionEditIndex = document.getElementById("optionEditIndex");
  if (optionEditIndex) optionEditIndex.value = "-1";
  const optionModalOverlay = document.getElementById("optionModalOverlay");
  if (optionModalOverlay) optionModalOverlay.style.display = "none";

  // -- Stage 6: Lease Clauses --------------------------------------------------
  const clausesContainer = document.getElementById("clausesContainer");
  if (clausesContainer) {
    clausesContainer.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">&#x1F4C4;</span>
        <p>No clauses available</p>
        <p class="empty-hint">Clauses will be loaded based on your lease configuration</p>
      </div>`;
  }
  window.sessionLeaseClauses = [];

  // -- Stage 7: Review ---------------------------------------------------------
  [
    "preview-unitsCount",
    "preview-recurringCount",
    "preview-depositsCount",
    "preview-optionsCount",
    "preview-clausesCount",
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = "0";
  });
  const previewTerm = document.getElementById("preview-leaseTerm");
  if (previewTerm) previewTerm.textContent = "-";
  const previewUnitsWithDetails = document.getElementById(
    "previewUnitsWithDetails",
  );
  if (previewUnitsWithDetails) previewUnitsWithDetails.innerHTML = "";

  // -- Close any open modals ---------------------------------------------------
  document.querySelectorAll(".modal.active").forEach((m) => closeModal(m.id));

  updateProgressBar();
  updateStageNavigation();

  // Re-initialize field states
  setTimeout(() => {
    document.querySelectorAll("input, select, textarea").forEach((input) => {
      input.removeAttribute("data-user-input");
      input.classList.remove("is-filled", "is-empty");
    });
    initializeFieldStateTracking();
  }, 100);

  // Auto-populate current user as Property Manager again after reset
  autoPopulateCurrentUserAsPropertyManager();

  // Clear the side-by-side PDF preview and any pending background autofill so a
  // reset leaves nothing from the previously uploaded document.
  if (
    window.LeasePdfPreview &&
    typeof window.LeasePdfPreview.unload === "function"
  ) {
    window.LeasePdfPreview.unload();
  }
  window._subAgentFlowState = "idle";
  window._pendingChargesAutofill = null;
  window._pendingSecurityAutofill = null;
  window._pendingOptionsAutofill = null;
  window._pendingClausesAutofill = null;
  window._pendingDiscountsAutofill = null;
  window._pendingCollateralAutofill = null;

  showNotification(" Form has been reset successfully", "success");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// Show delete confirmation modal
function showDeleteConfirm(title, message, onConfirm, confirmLabel) {
  const modal = document.getElementById("deleteConfirmModal");
  if (!modal) {
    console.error(" Delete confirmation modal not found!");
    return;
  }

  console.log(" Opening delete confirmation modal");

  document.getElementById("deleteConfirmTitle").textContent = title;
  document.getElementById("deleteConfirmMessage").textContent = message;

  // Optional custom confirm-button label (defaults to "Yes, Delete"); preserve the
  // leading SVG icon and swap only the trailing text.
  const _confirmBtn = document.getElementById("deleteConfirmBtn");
  if (_confirmBtn) {
    const _svg = _confirmBtn.querySelector("svg");
    _confirmBtn.innerHTML = "";
    if (_svg) _confirmBtn.appendChild(_svg);
    _confirmBtn.appendChild(
      document.createTextNode(" " + (confirmLabel || "Yes, Delete")),
    );
  }

  deleteConfirmCallback = onConfirm;

  modal.classList.add("active");
  document.body.style.overflow = "hidden";
}

// Close delete confirmation
function closeDeleteConfirm() {
  const modal = document.getElementById("deleteConfirmModal");
  if (!modal) return;

  console.log(" Closing delete confirmation modal...");

  // Remove modal from view
  modal.classList.remove("active");
  document.body.style.overflow = "auto";

  // Clear callback reference
  deleteConfirmCallback = null;

  console.log(" Delete confirmation modal closed");
}

// Confirm delete action
function confirmDelete() {
  console.log(
    "&#x1F5D1;&#xFE0F; Confirm delete clicked, callback exists:",
    !!deleteConfirmCallback,
  );

  // CRITICAL: Execute callback BEFORE closing modal
  if (deleteConfirmCallback) {
    try {
      console.log(" Executing delete callback...");
      deleteConfirmCallback();
      console.log(" Delete callback executed successfully");
    } catch (error) {
      console.error(" Error executing delete callback:", error);
    }
  } else {
    console.error(" No delete callback found!");
  }

  // Close modal AFTER callback executes
  closeDeleteConfirm();
}

//---------------------------------------------------------------------------------------------MODAL MANAGEMENT FUNCTIONS -------------------------------------//

// Helper function to escape HTML
function escapeHtml(text) {
  if (!text) return "";
  const map = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };
  return String(text).replace(/[&<>"']/g, (m) => map[m]);
}

// Close modal
function closeModal(modalId) {
  document.getElementById(modalId).classList.remove("active");
  document.body.style.overflow = "auto";
  clearModalInputs(modalId);
}

// Clear inputs
function clearModalInputs(modalId) {
  const modal = document.getElementById(modalId);
  modal.querySelectorAll("input, select, textarea").forEach((input) => {
    if (input.type === "checkbox") {
      input.checked = false;
    } else if (input.id !== "tenantSearchBox") {
      input.value = "";
    }
  });
}

//--------------------------------------------------------------------------STAGE 3 - COLLATERAL FUNCTIONS ----------------------------------------------------//

const COLLATERAL_TYPE_LABELS = {
  126330000: "Bank Guarantee",
  126330001: "Liab. Insurance",
  126330002: "Notary deed 777 p. 4 KPC",
  126330004: "Property insurance",
  126330005: "Corporate Guarantee",
  126330006: "Notary deed 777 p. 5 KPC",
  126330007: "Deposit",
};

function openCollateralRuleModal(editId = null) {
  document.getElementById("collateralRuleEditId").value = "";
  document.getElementById("collateralRuleCoefficient").value = "";
  currentRuleChargeTypes = [];

  populateCollateralChargeTypeDropdown();

  if (editId) {
    const rule = collateralRules.find((r) => r.id === editId);
    if (rule) {
      document.getElementById("collateralRuleEditId").value = rule.id;
      document.getElementById("collateralRuleCoefficient").value =
        rule.coefficient;
      currentRuleChargeTypes = rule.chargeTypes.map((ct) => ({ ...ct }));
      document.getElementById("collateralRuleModalTitle").textContent =
        "Edit Collateral Calculation Rule";
    }
  } else {
    document.getElementById("collateralRuleModalTitle").textContent =
      "Add Collateral Calculation Rule";
  }

  renderRuleChargeTypesList();
  document.getElementById("collateralRuleModal").classList.add("active");
  document.body.style.overflow = "hidden";
}

function populateCollateralChargeTypeDropdown() {
  const select = document.getElementById("collateralChargeTypeSelect");
  select.innerHTML = '<option value="">-- Select Charge Type --</option>';
  const types = window.chargeTypes || [];
  types.forEach((ct) => {
    const option = document.createElement("option");
    option.value = ct.array_chargetypeid;
    option.textContent = ct.array_name;
    select.appendChild(option);
  });
}

function addChargeTypeToRule() {
  const select = document.getElementById("collateralChargeTypeSelect");
  const chargeTypeId = select.value;
  const chargeTypeName = select.options[select.selectedIndex]?.text || "";

  if (!chargeTypeId) {
    showNotification("Please select a charge type", "warning");
    return;
  }

  if (currentRuleChargeTypes.some((ct) => ct.chargeTypeId === chargeTypeId)) {
    showNotification("This charge type is already added", "warning");
    return;
  }

  currentRuleChargeTypes.push({
    id: "ct_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5),
    chargeTypeId,
    chargeTypeName,
  });

  select.value = "";
  renderRuleChargeTypesList();
}

function removeChargeTypeFromRule(tempId) {
  currentRuleChargeTypes = currentRuleChargeTypes.filter(
    (ct) => ct.id !== tempId,
  );
  renderRuleChargeTypesList();
}

function renderRuleChargeTypesList() {
  const tbody = document.getElementById("collateralRuleChargeTypesList");
  if (!tbody) return;

  if (currentRuleChargeTypes.length === 0) {
    tbody.innerHTML = `<tr><td colspan="2" style="padding:14px;text-align:center;color:#94a3b8;font-size:13px;">No charge types added yet</td></tr>`;
    return;
  }

  tbody.innerHTML = currentRuleChargeTypes
    .map(
      (ct) => `
    <tr style="border-bottom:1px solid #f1f5f9;">
      <td style="padding:10px 14px;font-size:13px;color:#1a202c;">${escapeHtml(ct.chargeTypeName)}</td>
      <td style="padding:10px 14px;text-align:center;">
        <button onclick="removeChargeTypeFromRule('${ct.id}')" style="background:none;border:none;color:#e53e3e;cursor:pointer;font-size:16px;line-height:1;" title="Remove">&#x2715;</button>
      </td>
    </tr>`,
    )
    .join("");
}

function saveCollateralRule() {
  const rawCoefficient = document.getElementById(
    "collateralRuleCoefficient",
  ).value;
  const coefficient = parseInt(rawCoefficient, 10);

  if (rawCoefficient === "" || isNaN(coefficient) || coefficient < 0) {
    showNotification(
      "Please enter a valid whole number for coefficient",
      "warning",
    );
    return;
  }

  if (currentRuleChargeTypes.length === 0) {
    showNotification("Please add at least one charge type", "warning");
    return;
  }

  const editId = document.getElementById("collateralRuleEditId").value;

  if (editId) {
    const idx = collateralRules.findIndex((r) => r.id === editId);
    if (idx !== -1) {
      collateralRules[idx] = {
        ...collateralRules[idx],
        coefficient,
        chargeTypes: currentRuleChargeTypes.map((ct) => ({ ...ct })),
      };
    }
  } else {
    collateralRules.push({
      id: "rule_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5),
      coefficient,
      chargeTypes: currentRuleChargeTypes.map((ct) => ({ ...ct })),
      dataverseId: null,
    });
  }

  document.getElementById("collateralRuleModal").classList.remove("active");
  document.body.style.overflow = "auto";
  renderCollateralRules();
}

function deleteCollateralRule(ruleId) {
  showDeleteConfirm(
    "Remove Collateral Rule",
    "Remove this collateral rule? Any configurations linked to it will also be removed.",
    () => {
      collateralRules = collateralRules.filter((r) => r.id !== ruleId);
      collateralConfigs = collateralConfigs.filter((c) => c.ruleId !== ruleId);
      renderCollateralRules();
      renderCollateralConfigs();
    },
  );
}

function renderCollateralRules() {
  const container = document.getElementById("collateralRulesContainer");
  if (!container) return;

  if (collateralRules.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">&#x1F4CB;</span>
        <p>No rules added yet</p>
        <p class="empty-hint">Click "Add Rule" to create a collateral calculation rule</p>
      </div>`;
    return;
  }

  container.innerHTML = `
    <div class="charges-table-wrapper">
      <table class="charges-table">
        <thead>
          <tr>
            <th>Coefficient</th>
            <th>Charge Types</th>
            <th style="text-align:center;width:90px;">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${collateralRules
            .map(
              (rule) => `
            <tr>
              <td style="font-weight:700;color:var(--blue);">${escapeHtml(String(rule.coefficient))}</td>
              <td>
                ${rule.chargeTypes
                  .map(
                    (ct) =>
                      `<span class="tag tag-blue" style="margin:2px 4px 2px 0;">${escapeHtml(ct.chargeTypeName)}</span>`,
                  )
                  .join("")}
              </td>
              <td style="text-align:center;white-space:nowrap;">
                <span class="record-actions" style="justify-content:center;">
                  <button class="action-edit" onclick="openCollateralRuleModal('${rule.id}')" title="Edit"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
                  <button class="action-delete" onclick="deleteCollateralRule('${rule.id}')" title="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg></button>
                </span>
              </td>
            </tr>`,
            )
            .join("")}
        </tbody>
      </table>
    </div>`;
}

function openCollateralConfigModal(editId = null) {
  if (collateralRules.length === 0) {
    showNotification(
      "Please add at least one collateral rule first",
      "warning",
    );
    return;
  }

  document.getElementById("collateralConfigEditId").value = "";
  document.getElementById("collateralConfigTypeSelect").value = "";

  populateConfigRuleDropdown();

  if (editId) {
    const config = collateralConfigs.find((c) => c.id === editId);
    if (config) {
      document.getElementById("collateralConfigEditId").value = config.id;
      document.getElementById("collateralConfigRuleSelect").value =
        config.ruleId;
      document.getElementById("collateralConfigTypeSelect").value =
        config.collateralType;
      document.getElementById("collateralConfigModalTitle").textContent =
        "Edit Collateral Configuration";
    }
  } else {
    document.getElementById("collateralConfigModalTitle").textContent =
      "Add Collateral Configuration";
    document.getElementById("collateralConfigRuleSelect").value = "";
  }

  document.getElementById("collateralConfigModal").classList.add("active");
  document.body.style.overflow = "hidden";
}

function populateConfigRuleDropdown() {
  const select = document.getElementById("collateralConfigRuleSelect");
  select.innerHTML = '<option value="">-- Select Rule --</option>';
  collateralRules.forEach((rule) => {
    const option = document.createElement("option");
    option.value = rule.id;
    const chargeNames = rule.chargeTypes
      .map((ct) => ct.chargeTypeName)
      .join(", ");
    option.textContent = `Coefficient: ${rule.coefficient} - ${chargeNames}`;
    select.appendChild(option);
  });
}

function saveCollateralConfig() {
  const ruleId = document.getElementById("collateralConfigRuleSelect").value;
  const collateralType = document.getElementById(
    "collateralConfigTypeSelect",
  ).value;

  if (!ruleId) {
    showNotification("Please select a rule", "warning");
    return;
  }
  if (!collateralType) {
    showNotification("Please select a collateral type", "warning");
    return;
  }

  const rule = collateralRules.find((r) => r.id === ruleId);
  const editId = document.getElementById("collateralConfigEditId").value;

  const configData = {
    ruleId,
    ruleName: rule ? `Coefficient: ${rule.coefficient}` : "Unknown Rule",
    collateralType: parseInt(collateralType, 10),
    collateralTypeName:
      COLLATERAL_TYPE_LABELS[parseInt(collateralType, 10)] || "Unknown",
  };

  if (editId) {
    const idx = collateralConfigs.findIndex((c) => c.id === editId);
    if (idx !== -1) {
      collateralConfigs[idx] = { ...collateralConfigs[idx], ...configData };
    }
  } else {
    collateralConfigs.push({
      id: "cfg_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5),
      dataverseId: null,
      ...configData,
    });
  }

  document.getElementById("collateralConfigModal").classList.remove("active");
  document.body.style.overflow = "auto";
  renderCollateralConfigs();
}

function deleteCollateralConfig(configId) {
  showDeleteConfirm(
    "Remove Configuration",
    "Remove this collateral configuration?",
    () => {
      collateralConfigs = collateralConfigs.filter((c) => c.id !== configId);
      renderCollateralConfigs();
    },
  );
}

// Apply document-extracted collateral rules + configurations (stashed on the
// main autofill response as window._pendingCollateralAutofill). Charge-type
// strings are matched to Dataverse charge types by name; collateral-type
// strings are matched to COLLATERAL_TYPE_LABELS; each configuration is linked
// to a rule by matching coefficient. Runs once on first entry to Stage 3.
async function _createCollateralFromAutofill() {
  const data = window._pendingCollateralAutofill;
  if (!data) return;
  // Don't overwrite anything the user already entered.
  if (collateralRules.length > 0 || collateralConfigs.length > 0) {
    window._pendingCollateralAutofill = null;
    return;
  }
  window._pendingCollateralAutofill = null;

  // Charge types are needed to resolve charge-type names -> ids.
  if (!window.chargeTypes) {
    try {
      window.chargeTypes = await loadChargeTypes();
    } catch (e) {
      console.error("Collateral autofill: failed to load charge types:", e);
    }
  }

  const _norm = (s) =>
    String(s || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  const _uid = (prefix, i) =>
    `${prefix}_${Date.now()}_${i}_${Math.random().toString(36).substr(2, 5)}`;

  // Reverse map: normalized collateral label -> numeric option value.
  const _labelToValue = {};
  Object.keys(COLLATERAL_TYPE_LABELS).forEach((val) => {
    _labelToValue[_norm(COLLATERAL_TYPE_LABELS[val])] = parseInt(val, 10);
  });

  // Build rules. Each rule keeps its coefficient so configs can link by it.
  (data.rules || []).forEach((r, i) => {
    if (r.coefficient == null) return;
    const chargeTypes = (r.chargeTypes || [])
      .map((name) => {
        const match = resolveChargeType(window.chargeTypes || [], name);
        return {
          id: _uid("ct", i + "_" + name),
          chargeTypeId: match ? match.array_chargetypeid : "",
          chargeTypeName: match ? match.array_name : name,
        };
      })
      .filter((ct) => ct.chargeTypeName);
    collateralRules.push({
      id: _uid("rule", i),
      coefficient: r.coefficient,
      chargeTypes,
      dataverseId: null,
    });
  });

  // Build configs. Link each to a rule whose coefficient matches; fall back to
  // the first rule when none matches (so the config is still usable).
  (data.configs || []).forEach((c, i) => {
    const collateralType = _labelToValue[_norm(c.collateralType)];
    if (collateralType == null) return; // unknown collateral type - skip
    let rule =
      collateralRules.find((r) => r.coefficient === c.coefficient) ||
      collateralRules[0];
    if (!rule) return; // no rule to attach to
    collateralConfigs.push({
      id: _uid("cfg", i),
      dataverseId: null,
      ruleId: rule.id,
      ruleName: `Coefficient: ${rule.coefficient}`,
      collateralType,
      collateralTypeName: COLLATERAL_TYPE_LABELS[collateralType] || "Unknown",
    });
  });

  renderCollateralRules();
  renderCollateralConfigs();

  const _n = collateralRules.length + collateralConfigs.length;
  if (_n) {
    showNotification(
      `${collateralRules.length} collateral rule(s) and ${collateralConfigs.length} configuration(s) pre-filled from document. Review before saving.`,
      "info",
    );
  }
}

function renderCollateralConfigs() {
  const container = document.getElementById("collateralConfigContainer");
  if (!container) return;

  if (collateralConfigs.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">&#x1F512;</span>
        <p>No configurations added yet</p>
        <p class="empty-hint">Click "Add Configuration" to create a collateral configuration</p>
      </div>`;
    return;
  }

  container.innerHTML = `
    <div class="charges-table-wrapper">
      <table class="charges-table">
        <thead>
          <tr>
            <th>Rule</th>
            <th>Collateral Type</th>
            <th style="text-align:center;width:90px;">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${collateralConfigs
            .map(
              (config) => `
            <tr>
              <td style="color:var(--sub);">${escapeHtml(config.ruleName)}</td>
              <td><span class="tag tag-blue">${escapeHtml(config.collateralTypeName)}</span></td>
              <td style="text-align:center;white-space:nowrap;">
                <span class="record-actions" style="justify-content:center;">
                  <button class="action-edit" onclick="openCollateralConfigModal('${config.id}')" title="Edit"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
                  <button class="action-delete" onclick="deleteCollateralConfig('${config.id}')" title="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg></button>
                </span>
              </td>
            </tr>`,
            )
            .join("")}
        </tbody>
      </table>
    </div>`;
}

async function saveCollateralData(leaseAgreementId) {
  if (collateralRules.length === 0 && collateralConfigs.length === 0) {
    console.log("No collateral data to save - skipping");
    return;
  }

  const ruleIdMap = {};

  for (const rule of collateralRules) {
    const ruleRecord = {
      array_coefficient: rule.coefficient,
      "array_LeaseAgreement@odata.bind": `/array_leaseagreements(${leaseAgreementId})`,
    };

    const result = await XrmContext.WebApi.createRecord(
      "array_collateralcalculationrule",
      ruleRecord,
    );
    ruleIdMap[rule.id] = result.id;
    console.log(`Collateral rule created: ${result.id}`);

    for (const ct of rule.chargeTypes) {
      const chargeRecord = {
        "array_ChargeType@odata.bind": `/array_chargetypes(${ct.chargeTypeId})`,
        "array_Rule@odata.bind": `/array_collateralcalculationrules(${result.id})`,
      };
      await XrmContext.WebApi.createRecord(
        "array_collateralrulecharge",
        chargeRecord,
      );
    }
  }

  for (const config of collateralConfigs) {
    const dvRuleId = ruleIdMap[config.ruleId];
    if (!dvRuleId) {
      console.warn(
        "Skipping config - no Dataverse rule ID found for",
        config.ruleId,
      );
      continue;
    }

    const configRecord = {
      "array_Rule@odata.bind": `/array_collateralcalculationrules(${dvRuleId})`,
      // Schema property is `array_type` (NOT `array_collateraltype`, which doesn't
      // exist on array_collateralconfiguration - matches createCollateralRecords).
      array_type: config.collateralType,
    };

    await XrmContext.WebApi.createRecord(
      "array_collateralconfiguration",
      configRecord,
    );
    console.log(`Collateral configuration created for rule ${dvRuleId}`);
  }
}

// Event listeners
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const activeModal = document.querySelector(".modal.active");
    if (activeModal) {
      closeModal(activeModal.id);
    }
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const activeModal = document.querySelector(".modal.active");
    if (activeModal) {
      closeModal(activeModal.id);
    }
  }
});

//======================================================================================
// ######+##+      #####+ ##+   ##+#######+#######+    #######+##+   ##+###+   ##+ ######+########+##+ ######+ ###+   ##+#######+
// Merged from SW_JavaScript.js - Clause & Option logic for Stage 5 & 6
//======================================================================================

// ---- Global state needed by SW functions ----
let leaseResult = null; // Populated if needed from stage data
let choiceFieldMappings = {};
let cpiTypesLookup = {};
let vatLookup = {};
let chargeTypesLookup = { stepIncrease: {}, cpi: {} };
if (typeof documentData === "undefined") window.documentData = { units: [] };

// ---- Choice Field Metadata Loader ----
async function initializeChoiceFieldMappings() {
  const fieldsToLoad = [
    { field: "array_increasetype", entity: "array_leaseclause" },
    { field: "array_steprentfrequency", entity: "array_leaseclause" },
    { field: "array_calculationbasis", entity: "array_leaseclause" },
    { field: "array_settlementcycle", entity: "array_leaseclause" },
    { field: "array_reportingcycle", entity: "array_leaseclause" },
    { field: "array_cpirentfrequency", entity: "array_leaseclause" },
    { field: "array_paymentfrequency", entity: "array_leaseclause" },
    { field: "array_turnoverrentbasis", entity: "array_leaseclause" },
    { field: "array_turnoverrentcalculationtype", entity: "array_leaseclause" },
    { field: "array_increasetypeturnoverrent", entity: "array_leaseclause" },
    // CPI reference-month fields (global choices)
    { field: "array_cpireferencemonth", entity: "array_leaseclause" },
    { field: "array_cpicustommonth", entity: "array_leaseclause" },
  ];
  for (const item of fieldsToLoad) {
    try {
      const mapping = await getChoiceFieldMetadata(item.entity, item.field);
      if (mapping) choiceFieldMappings[item.field] = mapping;
    } catch (e) {
      console.error(`Failed to load ${item.field}:`, e);
    }
  }
  if (choiceFieldMappings["array_increasetype"]) {
    choiceFieldMappings["array_increasetypecpirentprocess"] =
      choiceFieldMappings["array_increasetype"];
  }
  // Fall back to the known global-choice values if metadata could not be read,
  // so the CPI Reference Month / Custom Month dropdowns stay usable.
  if (!choiceFieldMappings["array_cpireferencemonth"]) {
    choiceFieldMappings["array_cpireferencemonth"] = {
      "Start Month": 1,
      "Last Month": 2,
      "Custom Month": 3,
      "Latest Published Index Value": 4,
    };
  }
  if (!choiceFieldMappings["array_cpicustommonth"]) {
    choiceFieldMappings["array_cpicustommonth"] = {
      January: 1,
      February: 2,
      March: 3,
      April: 4,
      May: 5,
      June: 6,
      July: 7,
      August: 8,
      September: 9,
      October: 10,
      November: 11,
      December: 12,
    };
  }
  console.log(
    " Choice mappings loaded:",
    Object.keys(choiceFieldMappings).length,
    "fields",
  );
}

async function getChoiceFieldMetadata(entityName, fieldName) {
  try {
    const clientUrl =
      (
        window.parent?.Xrm || window.Xrm
      )?.Utility?.getGlobalContext()?.getClientUrl() || "";
    const apiUrl = `${clientUrl}/api/data/v9.2/EntityDefinitions(LogicalName='${entityName}')/Attributes(LogicalName='${fieldName}')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)`;
    const response = await fetch(apiUrl, {
      method: "GET",
      headers: {
        "OData-MaxVersion": "4.0",
        "OData-Version": "4.0",
        Accept: "application/json",
        "Content-Type": "application/json; charset=utf-8",
      },
      credentials: "same-origin",
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (data?.OptionSet?.Options) {
      const map = {};
      data.OptionSet.Options.forEach((o) => {
        const label = o.Label?.UserLocalizedLabel?.Label;
        if (label && o.Value !== null) map[label] = o.Value;
      });
      return map;
    }
    return null;
  } catch (e) {
    console.error(`Error fetching metadata for ${fieldName}:`, e);
    return null;
  }
}

async function loadCPITypesLookup() {
  try {
    const result = await XrmContext.WebApi.retrieveMultipleRecords(
      "array_cpitype",
      "?$select=array_cpitypeid,array_name&$filter=statecode eq 0&$orderby=array_name asc",
    );
    cpiTypesLookup = {};
    (result.entities || []).forEach((e) => {
      cpiTypesLookup[e.array_name] = e.array_cpitypeid;
    });
    console.log(` CPI Types loaded: ${Object.keys(cpiTypesLookup).length}`);
  } catch (e) {
    console.error("Error loading CPI Types:", e);
  }
}

async function loadVatsLookup() {
  try {
    const result = await XrmContext.WebApi.retrieveMultipleRecords(
      "array_vat",
      "?$select=array_vatid,array_name&$filter=statecode eq 0&$orderby=array_name asc",
    );
    vatLookup = {};
    (result.entities || []).forEach((e) => {
      vatLookup[e.array_name] = e.array_vatid;
    });
  } catch (e) {
    console.error("Error loading VATs:", e);
  }
  return vatLookup;
}

function generateVatOptions() {
  let opts = '<option value="">Select VAT</option>';
  for (const [name, id] of Object.entries(vatLookup))
    opts += `<option value="${id}">${name}</option>`;
  return opts;
}

async function loadCurrenciesLookup() {
  window.currencyLookup = window.currencyLookup || {};
  try {
    const result = await XrmContext.WebApi.retrieveMultipleRecords(
      "transactioncurrency",
      "?$select=transactioncurrencyid,currencyname&$filter=statecode eq 0&$orderby=currencyname asc",
    );
    (result.entities || []).forEach((e) => {
      window.currencyLookup[e.currencyname] = e.transactioncurrencyid;
    });
  } catch (e) {
    console.error("Error loading currencies:", e);
  }
}

function generateCurrencyOptions() {
  window.currencyLookup = window.currencyLookup || {};
  let opts = '<option value="">Select Currency</option>';
  for (const [name, id] of Object.entries(window.currencyLookup))
    opts += `<option value="${id}">${name}</option>`;
  return opts;
}

async function loadChargeTypesLookup() {
  try {
    const result = await XrmContext.WebApi.retrieveMultipleRecords(
      "array_chargetype",
      "?$select=array_chargetypeid,array_name,array_description,array_invoicelinename&$filter=statecode eq 0&$orderby=array_name asc",
    );
    const _ents = result.entities || [];
    chargeTypesLookup = { stepIncrease: {}, cpi: {}, records: _ents };
    // Count names so duplicate codes (e.g. two "AR" records) get a distinct label
    // instead of overwriting each other in the name-keyed map.
    const _nameCount = {};
    _ents.forEach((e) => {
      _nameCount[e.array_name] = (_nameCount[e.array_name] || 0) + 1;
    });
    _ents.forEach((e) => {
      let label = e.array_name;
      if (_nameCount[e.array_name] > 1) {
        const hint = String(
          e.array_description || e.array_invoicelinename || "",
        )
          .replace(/[â€žâ€œâ€"]/g, "")
          .trim();
        label = hint ? `${e.array_name} (${hint})` : e.array_name;
        if (chargeTypesLookup.stepIncrease[label]) {
          label = `${label} [${e.array_chargetypeid.slice(0, 4)}]`;
        }
      }
      chargeTypesLookup.stepIncrease[label] = e.array_chargetypeid;
      chargeTypesLookup.cpi[label] = e.array_chargetypeid;
    });
    console.log(
      ` Charge Types loaded: ${Object.keys(chargeTypesLookup.stepIncrease).length}`,
    );
  } catch (e) {
    console.error("Error loading charge types:", e);
  }
}

function generateChargeTypeOptions(type = "stepIncrease") {
  const ct = chargeTypesLookup[type] || {};
  if (!Object.keys(ct).length)
    return '<option value="">No charge types available</option>';
  return Object.entries(ct)
    .map(([name, id]) => `<option value="${id}">${name}</option>`)
    .join("");
}

function generateChoiceOptions(fieldName) {
  const choices = choiceFieldMappings[fieldName];
  if (!choices) return '<option value="">  Options not available</option>';
  return Object.entries(choices)
    .map(([label, value]) => `<option value="${value}">${label}</option>`)
    .join("");
}

function generateCPITypeOptions() {
  if (!Object.keys(cpiTypesLookup).length)
    return '<option value="">  CPI Types not available</option>';
  return Object.entries(cpiTypesLookup)
    .map(([name, id]) => `<option value="${id}">${name}</option>`)
    .join("");
}

// ---- Date helpers ----
function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (isNaN(date.getTime())) return "";
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${d}-${m}-${y}`;
}

function getTodayFormatted() {
  return formatDate(new Date());
}
function getTodayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---- Flatpickr initializer ----
function initializeDatePickers(container) {
  if (typeof flatpickr === "undefined") return;
  container.querySelectorAll(".flatpickr-date").forEach((input) => {
    if (input._flatpickr) input._flatpickr.destroy();
    flatpickr(input, {
      dateFormat: "d-m-Y",
      allowInput: true,
      clickOpens: true,
      disableMobile: false,
    });
  });
}

// ---- Helper value extractors ----
function getInputValue(container, selector) {
  const el = container.querySelector(selector);
  return el ? el.value.trim() : "";
}
function getTextareaValue(container, selector) {
  const el = container.querySelector(selector);
  return el ? el.value.trim() : "";
}
function getCheckboxValue(container, selector) {
  const el = container.querySelector(selector);
  return el ? el.checked : false;
}
function getSelectValue(container, selector) {
  const el = container.querySelector(selector);
  return el ? el.value || "" : "";
}

// ---- CPI current month auto-populate ----
async function getCurrentMonthCPIIndex(cpiTypeId) {
  try {
    const today = new Date();
    const cm = today.getMonth(),
      cy = today.getFullYear();
    const typeFilter = cpiTypeId
      ? `&$filter=_array_cpitype_value eq '${cpiTypeId}'`
      : "";
    const results = await XrmContext.WebApi.retrieveMultipleRecords(
      "array_cpiindex",
      `?$select=array_indexvalue,array_perioddate&$orderby=array_perioddate desc${typeFilter}`,
    );
    for (const entity of results.entities || []) {
      if (entity.array_perioddate) {
        const pd = new Date(entity.array_perioddate);
        if (pd.getMonth() === cm && pd.getFullYear() === cy)
          return entity.array_indexvalue ?? null;
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}
// Date Validation in the Cluase Stage (Effective and Expiary Date)
// Wires Effective/Expiry date validation. Each instance block carries its own
// date pair, so wire every .conditional-fields instance in scope independently;
// fall back to the scope itself for single-form (header-date) clause types.
function _setupClauseDateValidation(scope) {
  if (!scope) return;
  const blocks = scope.classList?.contains("conditional-fields")
    ? [scope]
    : Array.from(scope.querySelectorAll(".conditional-fields"));
  const targets = blocks.length ? blocks : [scope];
  targets.forEach((t) => _wireClauseDatePair(t));
}

function _wireClauseDatePair(form) {
  const effInput =
    form.querySelector(".clause-effective-date") ||
    form.querySelector(".form-grid .form-group:nth-child(1) input");
  const expInput =
    form.querySelector(".clause-expiry-date") ||
    form.querySelector(".form-grid .form-group:nth-child(2) input");

  if (!effInput || !expInput) return;
  // Guard against double-wiring when re-invoked on the same instance.
  if (effInput.dataset.dateWired === "1") return;
  effInput.dataset.dateWired = "1";

  const leaseStartDate = document.getElementById("startDate")?.value || "";
  const leaseEndDate = document.getElementById("endDate")?.value || "";

  // -- Apply initial min/max from lease dates -------------------------------
  // Effective Date: min = lease start, max = lease end
  if (leaseStartDate) effInput.min = leaseStartDate;
  if (leaseEndDate) effInput.max = leaseEndDate;

  // Expiry Date: min = max(leaseStart, effectiveDate), max = lease end
  if (leaseStartDate) expInput.min = leaseStartDate;
  if (leaseEndDate) expInput.max = leaseEndDate;

  // -- Cross-field validation: expiry must be >= effective ------------------
  function validateExpiryAgainstEffective() {
    if (!effInput.value || !expInput.value) return;
    const effDate = new Date(effInput.value);
    const expDate = new Date(expInput.value);
    if (expDate < effDate) {
      expInput.style.borderColor = "#ef4444";
      expInput.style.boxShadow = "0 0 0 3px rgba(239,68,68,0.15)";
      showNotification(
        " Expiry Date must be on or after the Effective Date",
        "error",
      );
      expInput.value = "";
      setTimeout(() => {
        expInput.style.borderColor = "";
        expInput.style.boxShadow = "";
      }, 1500);
    } else {
      expInput.style.borderColor = "";
      expInput.style.boxShadow = "";
    }
  }

  // -- Validate effective date against lease start/end bounds ---------------
  function validateEffectiveDate() {
    if (!effInput.value) {
      // Effective cleared - reset expiry min to lease start (or remove if no lease start)
      expInput.min = leaseStartDate || "";
      if (!leaseStartDate) expInput.removeAttribute("min");
      expInput.value = "";
      return;
    }

    const effDate = new Date(effInput.value);
    effDate.setHours(0, 0, 0, 0);

    // Must be >= lease start date
    if (leaseStartDate) {
      const leaseStart = new Date(leaseStartDate);
      leaseStart.setHours(0, 0, 0, 0);
      if (effDate < leaseStart) {
        effInput.style.borderColor = "#ef4444";
        effInput.style.boxShadow = "0 0 0 3px rgba(239,68,68,0.15)";
        showNotification(
          " Effective Date cannot be before the Lease Start Date",
          "error",
        );
        effInput.value = "";
        expInput.value = "";
        setTimeout(() => {
          effInput.style.borderColor = "";
          effInput.style.boxShadow = "";
        }, 1500);
        return;
      }
    }

    // Must be <= lease end date
    if (leaseEndDate) {
      const leaseEnd = new Date(leaseEndDate);
      leaseEnd.setHours(0, 0, 0, 0);
      if (effDate > leaseEnd) {
        effInput.style.borderColor = "#ef4444";
        effInput.style.boxShadow = "0 0 0 3px rgba(239,68,68,0.15)";
        showNotification(
          " Effective Date cannot be after the Lease End Date",
          "error",
        );
        effInput.value = "";
        expInput.value = "";
        setTimeout(() => {
          effInput.style.borderColor = "";
          effInput.style.boxShadow = "";
        }, 1500);
        return;
      }
    }

    effInput.style.borderColor = "";
    effInput.style.boxShadow = "";

    // Update expiry min to max(leaseStart, effectiveDate)
    expInput.min = effInput.value;

    // Clear expiry if it's now before the new effective date
    if (expInput.value && new Date(expInput.value) < effDate) {
      expInput.value = "";
      showNotification(
        "  Expiry Date was cleared as it was before the new Effective Date",
        "warning",
      );
    } else if (expInput.value) {
      validateExpiryAgainstEffective();
    }
  }

  // -- Validate expiry date against all bounds ------------------------------
  function validateExpiryDate() {
    if (!expInput.value) return;

    const expDate = new Date(expInput.value);
    expDate.setHours(0, 0, 0, 0);

    // Must be >= lease start date
    if (leaseStartDate) {
      const leaseStart = new Date(leaseStartDate);
      leaseStart.setHours(0, 0, 0, 0);
      if (expDate < leaseStart) {
        expInput.style.borderColor = "#ef4444";
        expInput.style.boxShadow = "0 0 0 3px rgba(239,68,68,0.15)";
        showNotification(
          " Expiry Date cannot be before the Lease Start Date",
          "error",
        );
        expInput.value = "";
        setTimeout(() => {
          expInput.style.borderColor = "";
          expInput.style.boxShadow = "";
        }, 1500);
        return;
      }
    }

    // Must be <= lease end date
    if (leaseEndDate) {
      const leaseEnd = new Date(leaseEndDate);
      leaseEnd.setHours(0, 0, 0, 0);
      if (expDate > leaseEnd) {
        expInput.style.borderColor = "#ef4444";
        expInput.style.boxShadow = "0 0 0 3px rgba(239,68,68,0.15)";
        showNotification(
          " Expiry Date cannot be after the Lease End Date",
          "error",
        );
        expInput.value = "";
        setTimeout(() => {
          expInput.style.borderColor = "";
          expInput.style.boxShadow = "";
        }, 1500);
        return;
      }
    }

    // Must be >= effective date
    validateExpiryAgainstEffective();
  }

  // -- Wire up event listeners ----------------------------------------------
  effInput.addEventListener("change", validateEffectiveDate);
  expInput.addEventListener("change", validateExpiryDate);

  // -- Set expiry min based on current effective date value -----------------
  if (effInput.value) {
    expInput.min = effInput.value;
  }
}

// ---- Display all clause types (manual mode - no lease ID needed) ----
function DisplayAllClauseTypes(targetContainerId, unitSuffix = "") {
  const container = document.getElementById(targetContainerId);
  if (!container) return;
  container.innerHTML = "";

  if (Object.keys(choiceFieldMappings).length === 0) {
    container.innerHTML = `<div style="padding:20px;color:#6b7280;text-align:center;">\u23F3 Loading configuration...</div>`;
    setTimeout(() => {
      if (Object.keys(choiceFieldMappings).length > 0)
        DisplayAllClauseTypes(targetContainerId, unitSuffix);
    }, 1000);
    return;
  }

  const clauseTypes = [
    "Step Rent Indexation",
    "Value Protection (CPI)",
    "Turnover Rent",
  ];

  // Visual metadata per clause (matches LeaseCreationWizard mockup).
  const CLAUSE_ICONS = {
    trending:
      '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
    receipt:
      '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1-2-1z"/><line x1="8" y1="7" x2="16" y2="7"/><line x1="8" y1="11" x2="16" y2="11"/>',
  };
  const CLAUSE_META = {
    "Step Rent Indexation": {
      color: "#0369A1",
      colorL: "#E0F2FE",
      icon: "trending",
      sub: "Predefined rent steps at fixed intervals",
    },
    "Value Protection (CPI)": {
      color: "#2E7D32",
      colorL: "#EDF7EE",
      icon: "trending",
      sub: "Index-linked rent adjustment",
    },
    "Turnover Rent": {
      color: "#7A4F0A",
      colorL: "#FFF8EC",
      icon: "receipt",
      sub: "Rent linked to tenant turnover figures",
    },
  };

  const header = document.createElement("div");
  header.className = "clause-selection-header";
  header.innerHTML = `<h3>Select Financial Clauses to Include</h3><p>Choose which clauses apply. Click a card to expand and configure.</p>`;
  container.appendChild(header);

  // Selector cards (3-up grid) - toggles drive the hidden checkbox below.
  const selectorGrid = document.createElement("div");
  selectorGrid.className = "clause-select-grid";
  container.appendChild(selectorGrid);

  // Config panels (one per active clause), rendered below the selector grid.
  const wrapper = document.createElement("div");
  wrapper.className = "manual-clauses-wrapper";
  container.appendChild(wrapper);

  for (const clauseType of clauseTypes) {
    const base = clauseType.replace(/[^a-zA-Z0-9]/g, "");
    const safeType = unitSuffix ? `${base}_${unitSuffix}` : base;
    const meta = CLAUSE_META[clauseType] || {
      color: "#1C6BD4",
      colorL: "#EBF3FF",
      icon: "trending",
      sub: "",
    };
    const iconSvg = CLAUSE_ICONS[meta.icon] || CLAUSE_ICONS.trending;

    // --- Selector card ---
    const card = document.createElement("div");
    card.className = "clause-select-card";
    card.id = `clauseCard-${safeType}`;
    card.style.setProperty("--cl", meta.color);
    card.style.setProperty("--clL", meta.colorL);
    card.innerHTML = `
      <div class="clause-card-check"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>
      <div class="clause-card-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${iconSvg}</svg></div>
      <div class="clause-card-title">${clauseType}</div>
      <div class="clause-card-sub">${meta.sub}</div>
    `;
    selectorGrid.appendChild(card);

    const itemWrapper = document.createElement("div");
    itemWrapper.className = "manual-clause-item-wrapper";
    itemWrapper.id = `clauseWrapper-${safeType}`;
    itemWrapper.style.display = "none";
    itemWrapper.style.setProperty("--cl", meta.color);
    itemWrapper.style.setProperty("--clL", meta.colorL);

    const checkHeader = document.createElement("div");
    checkHeader.className = "manual-clause-checkbox-header";
    checkHeader.innerHTML = `
      <div class="clause-panel-head-left">
        <span class="clause-panel-icon"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${iconSvg}</svg></span>
        <div>
          <div class="clause-panel-title">${clauseType}</div>
          <div class="clause-panel-count">${meta.sub}</div>
        </div>
      </div>
      <svg class="clause-panel-chevron" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
      <label class="manual-clause-checkbox-label" style="display:none;">
        <input type="checkbox" id="clauseCheck-${safeType}" data-clause-type="${clauseType}" data-safe-type="${safeType}">
        <span>${clauseType}</span>
      </label>
    `;

    const detailsForm = document.createElement("div");
    detailsForm.className = "manual-clause-details-form";
    detailsForm.id = `clauseDetails-${safeType}`;
    detailsForm.style.display = "none";

    const startDateVal = document.getElementById("startDate")?.value || "";
    const endDateVal = document.getElementById("endDate")?.value || "";

    // Instance-based clause types carry their own Effective/Expiry dates per
    // instance (added inside getClauseSpecificFieldsWithDynamicChoices). Only
    // single-form clause types use the shared clause-level header dates below.
    const hasInstanceDescriptions = [
      "Step Rent Indexation",
      "Value Protection (CPI)",
      "Turnover Rent",
    ].includes(clauseType);

    let formHTML = `<div class="clause-box" style="padding:0;border:none;margin:0;">`;
    if (!hasInstanceDescriptions) {
      formHTML += `<div class="clause-header-dates form-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
      <div class="form-group"><label style="font-size:12px;font-weight:600;color:var(--sub);display:block;margin-bottom:5px;">Effective Date <span style="color:var(--red);">*</span></label><input type="date" class="clause-date-input clause-effective-date" value="${startDateVal}" onclick="this.showPicker()" style="width:100%;padding:9px 11px;border:1px solid var(--border-m,#cbd5e1);border-radius:8px;font-size:13px;" /></div>
      <div class="form-group"><label style="font-size:12px;font-weight:600;color:var(--sub);display:block;margin-bottom:5px;">Expiry Date <span style="color:var(--red);">*</span></label><input type="date" class="clause-date-input clause-expiry-date" value="${endDateVal}" ${startDateVal ? `min="${startDateVal}"` : ""} onclick="this.showPicker()" style="width:100%;padding:9px 11px;border:1px solid var(--border-m,#cbd5e1);border-radius:8px;font-size:13px;" /></div>
    </div>`;
    }

    const addFields = getClauseSpecificFieldsWithDynamicChoices(
      clauseType,
      safeType,
    );
    if (addFields) formHTML += addFields;
    if (!hasInstanceDescriptions) {
      formHTML += `<div class="form-group" style="margin-top:12px;"><label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">Description</label><textarea placeholder="Enter a detailed description" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;min-height:70px;"></textarea></div>`;
    }
    formHTML += `</div>`;
    detailsForm.innerHTML = formHTML;

    itemWrapper.appendChild(checkHeader);
    itemWrapper.appendChild(detailsForm);
    wrapper.appendChild(itemWrapper);

    const checkbox = checkHeader.querySelector('input[type="checkbox"]');
    checkbox.addEventListener("change", function () {
      if (this.checked) {
        itemWrapper.style.display = "block";
        detailsForm.style.display = "block";
        itemWrapper.classList.add("expanded");
        itemWrapper.classList.remove("collapsed");
        card.classList.add("selected");
        setTimeout(() => {
          initializeDatePickers(detailsForm);
          setupClauseInteractivity(detailsForm, clauseType, safeType);

          //  NEW: Wire up real-time date validation as soon as form is visible
          _setupClauseDateValidation(detailsForm);

          if (clauseType === "Step Rent Indexation")
            setupStepRentInteractivity(detailsForm);
          if (clauseType === "Value Protection (CPI)") {
            setupCPIIncreaseTypeToggle(container);
            // Wired once per input (setupClauseInteractivity above may already
            // have done it) - avoids duplicate listeners / duplicate fetches.
            _wireCPIIndexRefresh(container, safeType);
          }
        }, 100);
      } else {
        itemWrapper.style.display = "none";
        detailsForm.style.display = "none";
        itemWrapper.classList.remove("expanded");
        card.classList.remove("selected");
      }
    });

    card.addEventListener("click", function () {
      checkbox.checked = !checkbox.checked;
      checkbox.dispatchEvent(new Event("change"));
    });

    // Click the panel header to collapse/expand its details (stays selected).
    checkHeader.addEventListener("click", function (e) {
      if (e.target.closest("input, button, a, label")) return;
      itemWrapper.classList.toggle("collapsed");
    });
  }
}

//new added
function clearPropertyManagerField() {
  document.getElementById("propertyManagerId").value = "";
  document.getElementById("propertyManagerDisplay").value = "";

  const display = document.getElementById("propertyManagerDisplay");
  display.removeAttribute("data-user-input");
  updateFieldState(display);

  const clearBtn = document.getElementById("clearPropertyManagerBtn");
  if (clearBtn) clearBtn.style.display = "none";
}
// ---- Clause-specific fields with dynamic choice options ----
function getClauseSpecificFieldsWithDynamicChoices(clauseType, safeType) {
  if (Object.keys(choiceFieldMappings).length === 0)
    return '<div style="color:red;padding:8px;">  Configuration loading...</div>';

  // Per-instance Effective/Expiry dates - each instance carries its own pair,
  // defaulted to the lease term. Reused across step/cpi/turnover instance 1.
  const _sd = document.getElementById("startDate")?.value || "";
  const _ed = document.getElementById("endDate")?.value || "";
  // Effective / Expiry fields kept separate so CPI can place them in its own
  // field order (after Initial Waiting Period); Step Rent / Turnover still use
  // the instanceDatesHTML row at the top of the instance.
  const effDateFieldHTML = `<div class="form-group"><label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">Effective Date <span style="color:#ef4444;">*</span></label><input type="date" class="clause-date-input clause-effective-date" value="${_sd}" onclick="this.showPicker()" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;"></div>`;
  const expDateFieldHTML = `<div class="form-group"><label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">Expiry Date <span style="color:#ef4444;">*</span></label><input type="date" class="clause-date-input clause-expiry-date" value="${_ed}" ${_sd ? `min="${_sd}"` : ""} onclick="this.showPicker()" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;"></div>`;
  const instanceDatesHTML = `<div class="form-grid instance-dates" style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
        ${effDateFieldHTML}
        ${expDateFieldHTML}
      </div>`;

  let html = "";
  switch (clauseType) {
    case "Step Rent Indexation": {
      const incOpts = generateChoiceOptions("array_increasetype");
      const freqOpts = generateChoiceOptions("array_steprentfrequency");
      const ctOpts = generateChargeTypeOptions("stepIncrease");
      html = `<div id="stepRentFields-${safeType}" class="conditional-fields" style="margin-top:12px;">
        <div class="instance-title" style="font-weight:600;font-size:13px;color:#374151;margin-bottom:8px;">Instance 1</div>
        <button type="button" class="remove-instance-btn" onclick="removeClauseInstance(this,'stepRent')">Remove</button>
        ${instanceDatesHTML}
        <div class="form-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
          <div class="form-group"><label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">Charge Type (Step Increase) <span style="color:#ef4444;">*</span></label><select id="chargeTypeStepIncrease-${safeType}" class="charge-type-step-select" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;"><option value="">Select charge type</option>${ctOpts}</select></div>
          <div class="form-group"><label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">Increase Type <span style="color:#ef4444;">*</span></label><select class="increase-type-step-select" id="increaseType-${safeType}" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;"><option value="">Select type</option>${incOpts}</select></div>
          <div class="form-group flat-field-wrapper" id="flatField-${safeType}" style="display:none;"><label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">Flat Amount <span style="color:#ef4444;">*</span></label><input type="number" placeholder="Enter amount" step="any" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;"></div>
          <div class="form-group percent-field-wrapper" id="percentField-${safeType}" style="display:none;"><label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">Step Rent Percentage (%) <span style="color:#ef4444;">*</span></label><input type="number" placeholder="Enter percentage" step="any" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;"></div>
          <div class="form-group"><label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">Step Rent Frequency <span style="color:#ef4444;">*</span></label><select class="step-rent-frequency-select" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;"><option value="">Select frequency</option>${freqOpts}</select></div>
          <div class="form-group step-custom-toggle-wrapper"><label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">Enable Custom Step Rent Schedule</label><div style="display:flex;align-items:center;gap:8px;margin-top:6px;"><label class="toggle-switch" style="margin:0;"><input type="checkbox" class="custom-step-toggle"><span class="slider"></span></label><span style="font-size:13px;">Yes</span></div></div>
          <div class="form-group step-cycle-start-wrapper" style="display:none;"><label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">Step Rent Cycle Start Date <span style="color:#ef4444;">*</span></label><input type="date" class="clause-date-input step-cycle-start-input" value="${getTodayISO()}" onclick="this.showPicker()" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;"></div>
          <div class="form-group step-cycle-end-wrapper" style="display:none;"><label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">Step Rent Cycle End Date</label><input type="date" class="clause-date-input step-cycle-end-input" readonly style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;background:#f3f4f6;cursor:not-allowed;"></div>
        </div>
        <div class="form-group" style="margin-top:12px;"><label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">Clause Summary</label><textarea class="step-clause-summary" placeholder="Enter a summary for this clause" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;min-height:60px;"></textarea></div>
        <button type="button" class="add-instance-btn" onclick="addClauseInstance(this,'stepRent')">+ Add another step</button>
      </div>`;
      break;
    }

    case "Value Protection (CPI)": {
      const incCPI = generateChoiceOptions("array_increasetypecpirentprocess");
      const cpiTypeOpts = generateCPITypeOptions();
      const cpiFreqOpts = generateChoiceOptions("array_cpirentfrequency");
      const cpiCtOpts = generateChargeTypeOptions("cpi");
      const cpiCustMonthOpts = generateChoiceOptions("array_cpicustommonth");
      html = `<div id="cpiFields-${safeType}" class="conditional-fields" style="margin-top:12px;">
        <div class="instance-title" style="font-weight:600;font-size:13px;color:#374151;margin-bottom:8px;">Instance 1</div>
        <button type="button" class="remove-instance-btn" onclick="removeClauseInstance(this,'cpi')">Remove</button>
        <!-- Field order mirrors the Lease Clause form: dates & schedule first, then indexation details -->
        <div class="form-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
          <div class="form-group"><label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">Initial Waiting Period (Months)</label><input type="number" placeholder="Enter months" min="0" class="initial-waiting-period-input" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;"></div>
          ${effDateFieldHTML}
          ${expDateFieldHTML}
          <div class="form-group cpi-custom-toggle-wrapper"><label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">Enable Custom CPI Schedule</label><div style="display:flex;align-items:center;gap:8px;margin-top:6px;"><label class="toggle-switch" style="margin:0;"><input type="checkbox" class="custom-cpi-toggle" id="customCPIToggle-${safeType}"><span class="slider"></span></label><span style="font-size:13px;">Yes</span></div></div>
          <div class="form-group cpi-cycle-start-wrapper" style="display:none;"><label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">CPI 2nd Schedule Start Date <span style="color:#ef4444;">*</span></label><input type="date" class="cpi-cycle-start-input" id="cpiCycleStart-${safeType}" onclick="this.showPicker()" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;"></div>
          <div class="form-group cpi-cycle-end-wrapper" style="display:none;"><label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">CPI 2nd Schedule End Date</label><input type="text" id="cpiCycleEnd-${safeType}" readonly style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;background:#f3f4f6;cursor:not-allowed;"></div>
          <div class="form-group skip-first-cpi-wrapper"><label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">Skip First CPI Schedule</label><div style="display:flex;align-items:center;gap:8px;margin-top:6px;"><label class="toggle-switch" style="margin:0;"><input type="checkbox" class="skip-first-cpi-toggle"><span class="slider"></span></label><span style="font-size:13px;">Yes</span></div><div class="skip-first-cpi-info" style="display:none;margin-top:6px;font-size:12px;color:#1e40af;background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;padding:6px 8px;line-height:1.4;">The first CPI schedule will not be generated; indexation applies from the next cycle.</div></div>
          <div class="cpi-schedule-cycles-info" style="display:none;grid-column:1 / -1;font-size:12px;line-height:1.5;color:#374151;background:#f8fafc;border:1px solid #e5e7eb;border-left:3px solid #2563eb;border-radius:6px;padding:8px 10px;"></div>
        </div>
        <div class="form-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px;">
          <div class="form-group"><label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">CPI Type <span style="color:#ef4444;">*</span></label><select style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;"><option value="">Select type</option>${cpiTypeOpts}</select></div>
          <div class="form-group"><label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">Charge Type (CPI) <span style="color:#ef4444;">*</span></label><select id="chargeTypeCPI-${safeType}" class="charge-type-cpi-select" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;"><option value="">Select charge type</option>${cpiCtOpts}</select></div>
          <div class="form-group"><label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">Current Index <span style="color:#ef4444;">*</span></label><input type="number" id="currentIndexInput-${safeType}" placeholder="Enter index" step="any" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;"></div>
          <div class="form-group"><label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">CPI Rent Frequency <span style="color:#ef4444;">*</span></label><select class="cpi-rent-frequency-select" id="cpiFrequency-${safeType}" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;"><option value="">Select frequency</option>${cpiFreqOpts}</select></div>
          <div class="form-group cpi-reference-month-wrapper" style="display:none;"><label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">CPI Reference Month <span style="color:#ef4444;">*</span></label><select class="cpi-reference-month-select" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;"><option value="">Select reference month</option></select></div>
          <div class="form-group cpi-custom-month-wrapper" style="display:none;"><label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">CPI Custom Month <span style="color:#ef4444;">*</span></label><select class="cpi-custom-month-select" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;"><option value="">Select month</option>${cpiCustMonthOpts}</select><div class="cpi-custom-month-info" style="margin-top:6px;font-size:12px;color:#1e40af;background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;padding:6px 8px;line-height:1.4;">Each yearly CPI adjustment will use the index value published for the selected month.</div></div>
          <div class="form-group"><label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">Minimum Time Interval (Months)</label><input type="number" placeholder="Enter months" min="0" class="min-time-interval-input" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;"></div>
          <div class="form-group"><label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">Trigger Value (%)</label><input type="number" placeholder="Enter percentage" step="any" class="trigger-value-input" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;"></div>
          <div class="form-group"><label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">Increase Type (CPI Rent Process) <span style="color:#ef4444;">*</span></label><select id="increaseTypeCPI-${safeType}" class="increase-type-cpi-select" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;"><option value="">Select type</option>${incCPI}</select></div>
          <div class="form-group" id="cpiFlatAmountField-${safeType}" style="display:none;"><label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">Flat Amount (CPI)</label><input type="number" placeholder="Enter amount" step="any" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;"></div>
          <div class="form-group" id="cpiMinFlatAmountField-${safeType}" style="display:none;"><label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">Minimum Increase Flat Amount (CPI)</label><input type="number" placeholder="Enter amount" step="any" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;"></div>
          <div class="form-group" id="cpiMinPercentField-${safeType}" style="display:none;"><label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">Minimum Increase Percentage (CPI)</label><input type="number" placeholder="Enter percentage" step="any" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;"></div>
          <div class="form-group" id="cpiMaxPercentField-${safeType}" style="display:none;"><label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">Maximum Increase Percentage (CPI)</label><input type="number" placeholder="Enter percentage" step="any" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;"></div>
        </div>
        <div class="form-group" style="margin-top:12px;"><label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">Clause Summary</label><textarea class="cpi-clause-summary" placeholder="Enter a summary for this clause" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;min-height:60px;"></textarea></div>
        <button type="button" class="add-instance-btn" onclick="addClauseInstance(this,'cpi')">+ Add another CPI instance</button>
      </div>`;
      break;
    }

    case "Turnover Rent": {
      const basisOpts = generateChoiceOptions("array_turnoverrentbasis");
      const settlOpts = generateChoiceOptions("array_settlementcycle");
      const repOpts = generateChoiceOptions("array_reportingcycle");
      const calcOpts = generateChoiceOptions(
        "array_turnoverrentcalculationtype",
      );
      const incTOpts = generateChoiceOptions("array_increasetypeturnoverrent");
      const ctTOpts = generateChargeTypeOptions("stepIncrease");
      const vatOpts = generateVatOptions();
      const curOpts = generateCurrencyOptions();

      html = `<div id="turnoverFields-${safeType}" class="conditional-fields" style="margin-top:12px;">
    <div class="instance-title" style="font-weight:600;font-size:13px;color:#374151;margin-bottom:8px;">Instance 1</div>
    <button type="button" class="remove-instance-btn" onclick="removeClauseInstance(this,'turnover')">Remove</button>
    ${instanceDatesHTML}
    <div class="form-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">

      <div class="form-group">
        <label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">Subject to VAT</label>
        <div style="display:flex;align-items:center;gap:8px;margin-top:6px;">
          <label class="toggle-switch" style="margin:0;"><input type="checkbox" class="vat-toggle"><span class="slider"></span></label>
          <span style="font-size:13px;">Yes</span>
        </div>
      </div>

      <div class="form-group vat-conditional-field" style="display:none;">
        <label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">VAT</label>
        <select class="vat-select" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;">${vatOpts}</select>
      </div>

      <div class="form-group">
        <label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">Enable OCR</label>
        <div style="display:flex;align-items:center;gap:8px;margin-top:6px;">
          <label class="toggle-switch" style="margin:0;"><input type="checkbox" class="ocr-toggle"><span class="slider"></span></label>
          <span style="font-size:13px;">Yes</span>
        </div>
      </div>

      <div class="form-group">
        <label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">Turnover Rent Basis <span style="color:red;">*</span></label>
        <select class="turnover-basis-select" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;">
          <option value="">Select basis</option>${basisOpts}
        </select>
      </div>

      <div class="form-group">
        <label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">Currency</label>
        <select class="currency-select" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;">${curOpts}</select>
      </div>

      <div class="form-group sales-threshold-wrapper">
        <label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">Sales Threshold <span style="color:red;">*</span></label>
        <input type="number" placeholder="Enter amount" step="any" class="sales-threshold-input" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;">
      </div>

      <div class="form-group">
        <label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">Charge Type for Advance (Turnover Rent) <span style="color:red;">*</span></label>
        <select class="charge-type-turnover-select" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;">
          <option value="">Select charge type</option>${ctTOpts}
        </select>
      </div>

      <div class="form-group secondary-charge-wrapper" style="display:none;">
        <label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">Secondary Charge Type for Advance</label>
        <select class="secondary-charge-type-select" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;">
          <option value="">Select charge type</option>${ctTOpts}
        </select>
      </div>

      <div class="form-group">
        <label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">Settlement Cycle <span style="color:red;">*</span></label>
        <select class="turnover-settlement-select" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;">
          <option value="">Select cycle</option>${settlOpts}
        </select>
      </div>

      <div class="form-group">
        <label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">Enable Proration</label>
        <div style="display:flex;align-items:center;gap:8px;margin-top:6px;">
          <label class="toggle-switch" style="margin:0;"><input type="checkbox" class="proration-toggle"><span class="slider"></span></label>
          <span style="font-size:13px;">Yes</span>
        </div>
      </div>

      <div class="form-group">
        <label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">Enable Custom Schedule</label>
        <div style="display:flex;align-items:center;gap:8px;margin-top:6px;">
          <label class="toggle-switch" style="margin:0;"><input type="checkbox" class="custom-turnover-toggle"><span class="slider"></span></label>
          <span style="font-size:13px;">Yes</span>
        </div>
      </div>

      <div class="form-group turnover-start-wrapper" style="display:none;">
        <label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">Turnover Cycle Start Date</label>
        <input type="date" class="clause-date-input turnover-start-input" onclick="this.showPicker()" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;">
      </div>

      <div class="form-group turnover-end-wrapper" style="display:none;">
        <label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">Turnover Cycle End Date</label>
        <input type="date" class="turnover-end-input" readonly style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;background:#f3f4f6;cursor:not-allowed;">
      </div>

      <div class="form-group">
        <label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">Reporting Cycle <span style="color:red;">*</span></label>
        <select class="turnover-reporting-select" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;">
          <option value="">Select cycle</option>${repOpts}
        </select>
      </div>

      <div class="form-group">
        <label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">Turnover Rent Calculation Type <span style="color:red;">*</span></label>
        <select class="turnover-calc-type-select" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;">
          <option value="">Select type</option>${calcOpts}
        </select>
      </div>

      <div class="form-group turnover-increase-wrapper">
        <label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">Increase Type (Turnover Rent) <span style="color:red;">*</span></label>
        <select class="turnover-increase-select" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;">
          <option value="">Select type</option>${incTOpts}
        </select>
      </div>

      <div class="form-group turnover-flat-amount-wrapper" style="display:none;">
        <label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">Flat Amount (Turnover Rent) <span style="color:red;">*</span></label>
        <input type="number" placeholder="Enter amount" step="any" class="turnover-flat-amount-input" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;">
      </div>

      <div class="form-group turnover-min-sales-flat-wrapper" style="display:none;">
        <label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">Minimum Sales-Based Rent Amount</label>
        <input type="number" placeholder="Enter amount" step="any" class="min-sales-input" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;">
      </div>

      <div class="form-group turnover-rate-wrapper" style="display:none;">
        <label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">Turnover Rate (%) <span style="color:red;">*</span></label>
        <input type="number" placeholder="Enter percentage" step="any" class="turnover-rate-input" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;">
      </div>

      <div class="form-group turnover-min-pct-wrapper" style="display:none;">
        <label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">Minimum Turnover Percentage</label>
        <input type="number" placeholder="Enter percentage" step="any" class="turnover-min-pct-input" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;">
      </div>

    </div>
    <div class="form-group" style="margin-top:12px;">
      <label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px;">Clause Summary</label>
      <textarea class="turnover-clause-summary" placeholder="Enter a summary for this clause" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;min-height:60px;"></textarea>
    </div>
    <button type="button" class="add-instance-btn" onclick="addClauseInstance(this,'turnover')">+ Add another turnover configuration</button>
  </div>`;
      break;
    }
  }
  return html;
}

// ---- Clause interactivity setup ----
function setupClauseInteractivity(container, clauseType, safeType) {
  if (clauseType === "Step Rent Indexation")
    setupStepRentInteractivity(container);
  if (clauseType === "Turnover Rent") {
    const turnoverBlock =
      container.querySelector(`[id^='turnoverFields-']`) || container;
    setupTurnoverRentInteractivity(turnoverBlock);
  }
  if (clauseType === "Value Protection (CPI)") {
    setupCPIIncreaseTypeToggle(container);
    _wireCPIIndexRefresh(container, safeType);
  }
}

// -----------------------------------------------------------------------------
// CPI "Current Index" auto-lookup (current-month value from array_cpiindex).
// Rules:
//  - wired once per input (no duplicate listeners / fetches)
//  - never fetches without a CPI Type (an unfiltered query returned the first
//    index row of ANY type)
//  - never runs while the document autofill is filling clauses
//  - never overwrites a value typed by the user or supplied by the document;
//    only an empty field or a previous auto-lookup value is replaced
//  - ignores late responses (CPI type changed / newer request started)
// -----------------------------------------------------------------------------
function _wireCPIIndexRefresh(container, safeType) {
  if (!container) return;
  const idx = container.querySelector(`#currentIndexInput-${safeType}`);
  if (!idx || idx.dataset.cpiIndexWired === "1") return;
  idx.dataset.cpiIndexWired = "1";

  const cpiTypeSel = container.querySelectorAll(
    "select:not(.increase-type-cpi-select):not(.charge-type-cpi-select):not(.cpi-rent-frequency-select)",
  )[0];

  idx.addEventListener("input", () => {
    idx.dataset.cpiIndexSource = idx.value ? "manual" : "";
  });

  let seq = 0;
  function refreshCPIIndex() {
    if (window._clausesAutofillInProgress === true) return;
    const src = idx.dataset.cpiIndexSource || "";
    if (idx.value && src !== "auto") return; // user / document value wins
    const cpiTypeId = cpiTypeSel ? cpiTypeSel.value : "";
    if (!cpiTypeId) {
      if (!idx.value) idx.placeholder = "Select CPI type first";
      return;
    }
    const mySeq = ++seq;
    idx.placeholder = "Checking...";
    getCurrentMonthCPIIndex(cpiTypeId).then((v) => {
      if (mySeq !== seq) return; // a newer request superseded this one
      if (!cpiTypeSel || cpiTypeSel.value !== cpiTypeId) return;
      const nowSrc = idx.dataset.cpiIndexSource || "";
      if (idx.value && nowSrc !== "auto") return; // filled meanwhile
      if (v !== null && v !== undefined && v !== "") {
        idx.value = v;
        idx.dataset.cpiIndexSource = "auto";
        idx.placeholder = "Enter index";
      } else {
        if (nowSrc === "auto") idx.value = "";
        idx.placeholder = "Enter index manually";
      }
    });
  }

  if (cpiTypeSel) cpiTypeSel.addEventListener("change", refreshCPIIndex);
  refreshCPIIndex();
}

function _calcStepRentEndDate(block) {
  const si = block.querySelector(".step-cycle-start-input");
  const ei = block.querySelector(".step-cycle-end-input");
  const fs = block.querySelector(".step-rent-frequency-select");
  if (!si || !ei || !fs || !si.value || !fs.value) return;
  const d = new Date(si.value);
  if (isNaN(d.getTime())) return;
  const txt = fs.options[fs.selectedIndex]?.text.toLowerCase() || "";
  const add = txt.includes("month")
    ? 1
    : txt.includes("quarter")
      ? 3
      : txt.includes("half")
        ? 6
        : txt.includes("year")
          ? 12
          : txt.includes("week")
            ? 0
            : 0;
  if (add) {
    d.setMonth(d.getMonth() + add);
    d.setDate(d.getDate() - 1); // end date is last day of period
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    ei.value = `${yyyy}-${mm}-${dd}`;
  }
}

// -----------------------------------------------------------------------------
// HELPER: Get effective and expiry dates from the clause form wrapper
// -----------------------------------------------------------------------------
function _getClauseEffectiveAndExpiryDates(block) {
  // Instance-based clauses carry their own Effective/Expiry dates inside the
  // .conditional-fields instance block. Read those first; fall back to the
  // shared clause-level header dates (single-form clause types).
  const instance =
    block.closest?.(".conditional-fields") ||
    (block.classList?.contains("conditional-fields") ? block : null);

  if (instance) {
    const ie = instance.querySelector(".clause-effective-date");
    const ix = instance.querySelector(".clause-expiry-date");
    if (ie || ix) {
      return {
        effectiveDate: ie?.value || "",
        expiryDate: ix?.value || "",
      };
    }
  }

  const form =
    block.closest(".manual-clause-details-form") ||
    block.parentElement?.closest(".manual-clause-details-form");

  if (!form) return { effectiveDate: "", expiryDate: "" };

  const effInput =
    form.querySelector(".clause-header-dates .clause-effective-date") ||
    form.querySelector(".clause-effective-date");
  const expInput =
    form.querySelector(".clause-header-dates .clause-expiry-date") ||
    form.querySelector(".clause-expiry-date");

  return {
    effectiveDate: effInput?.value || "",
    expiryDate: expInput?.value || "",
  };
}

// -----------------------------------------------------------------------------
// STEP RENT INDEXATION - setup interactivity
// -----------------------------------------------------------------------------
function setupStepRentInteractivity(container) {
  // -- Compute Step Rent Cycle End Date from start + frequency, capped to expiry --
  function _calcStepRentEndDateLocal(block) {
    const si = block.querySelector(".step-cycle-start-input");
    const ei = block.querySelector(".step-cycle-end-input");
    const fs = block.querySelector(".step-rent-frequency-select");
    if (!si || !ei || !fs || !si.value || !fs.value) return;

    const d = new Date(si.value);
    if (isNaN(d.getTime())) return;

    const txt = fs.options[fs.selectedIndex]?.text.toLowerCase() || "";
    const addMonths = txt.includes("month")
      ? 1
      : txt.includes("quarter")
        ? 3
        : txt.includes("half")
          ? 6
          : txt.includes("year")
            ? 12
            : 0;

    if (!addMonths) {
      ei.value = "";
      return;
    }

    d.setMonth(d.getMonth() + addMonths);
    d.setDate(d.getDate() - 1); // last day of period

    // Cap to clause expiry date
    const { expiryDate } = _getClauseEffectiveAndExpiryDates(block);
    if (expiryDate) {
      const expDate = new Date(expiryDate);
      expDate.setHours(0, 0, 0, 0);
      d.setHours(0, 0, 0, 0);
      if (d > expDate) {
        d.setTime(expDate.getTime());
        console.log(
          `  Step Rent Cycle End Date capped to clause expiry: ${expiryDate}`,
        );
      }
    }

    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    ei.value = `${yyyy}-${mm}-${dd}`;
  }

  // -- Apply min/max on Step Rent Cycle Start Date from effective & expiry --
  function _applyStepCycleStartConstraints(block) {
    const si = block.querySelector(".step-cycle-start-input");
    if (!si) return;

    const { effectiveDate, expiryDate } =
      _getClauseEffectiveAndExpiryDates(block);

    if (effectiveDate) si.min = effectiveDate;
    else si.removeAttribute("min");

    if (expiryDate) si.max = expiryDate;
    else si.removeAttribute("max");
  }

  // -- Validate the selected Step Rent Cycle Start Date ----------------------
  function _validateStepCycleStartDate(block, input) {
    if (!input.value) return true;

    const { effectiveDate, expiryDate } =
      _getClauseEffectiveAndExpiryDates(block);
    const selected = new Date(input.value);
    selected.setHours(0, 0, 0, 0);

    if (effectiveDate) {
      const effDate = new Date(effectiveDate);
      effDate.setHours(0, 0, 0, 0);
      if (selected < effDate) {
        input.style.borderColor = "#ef4444";
        input.style.boxShadow = "0 0 0 3px rgba(239,68,68,0.15)";
        showNotification(
          " Step Rent Cycle Start Date cannot be before the Effective Date",
          "error",
        );
        input.value = "";
        setTimeout(() => {
          input.style.borderColor = "";
          input.style.boxShadow = "";
        }, 1500);
        return false;
      }
    }

    if (expiryDate) {
      const expDate = new Date(expiryDate);
      expDate.setHours(0, 0, 0, 0);
      if (selected > expDate) {
        input.style.borderColor = "#ef4444";
        input.style.boxShadow = "0 0 0 3px rgba(239,68,68,0.15)";
        showNotification(
          " Step Rent Cycle Start Date cannot be after the Expiry Date",
          "error",
        );
        input.value = "";
        setTimeout(() => {
          input.style.borderColor = "";
          input.style.boxShadow = "";
        }, 1500);
        return false;
      }
    }

    input.style.borderColor = "";
    input.style.boxShadow = "";
    return true;
  }

  // -- Main change event listener --------------------------------------------
  container.addEventListener("change", function (e) {
    const target = e.target;
    const block = target.closest(".conditional-fields") || container;

    // Increase type toggle (flat vs percentage)
    if (
      target.classList.contains("increase-type-step-select") ||
      (target.id && target.id.includes("increaseType-"))
    ) {
      const flatF = block.querySelector(".flat-field-wrapper");
      const pctF = block.querySelector(".percent-field-wrapper");
      const txt =
        target.options[target.selectedIndex]?.text.toLowerCase() || "";
      if (flatF)
        flatF.style.display =
          txt.includes("flat") || txt.includes("amount") ? "block" : "none";
      if (pctF) pctF.style.display = txt.includes("percent") ? "block" : "none";
    }

    // Custom schedule toggle
    if (target.classList.contains("custom-step-toggle")) {
      const sw = block.querySelector(".step-cycle-start-wrapper");
      const ew = block.querySelector(".step-cycle-end-wrapper");
      if (sw) sw.style.display = target.checked ? "block" : "none";
      if (ew) ew.style.display = target.checked ? "block" : "none";

      if (target.checked) {
        // Apply date constraints then compute end date
        setTimeout(() => {
          _applyStepCycleStartConstraints(block);
          _calcStepRentEndDateLocal(block);
        }, 50);
      } else {
        // Clear both dates when custom schedule is turned off
        const si = block.querySelector(".step-cycle-start-input");
        const ei = block.querySelector(".step-cycle-end-input");
        if (si) si.value = "";
        if (ei) ei.value = "";
      }
    }

    // Step Rent Cycle Start Date changed - validate then recompute end date
    if (target.classList.contains("step-cycle-start-input")) {
      const valid = _validateStepCycleStartDate(block, target);
      if (valid) _calcStepRentEndDateLocal(block);
    }

    // Frequency changed - recompute end date if toggle is on
    if (target.classList.contains("step-rent-frequency-select")) {
      const tog = block.querySelector(".custom-step-toggle");
      if (tog && tog.checked) _calcStepRentEndDateLocal(block);
    }
  });

  // -- Lock end date - auto-populated only -----------------------------------
  container.querySelectorAll(".step-cycle-end-input").forEach((ei) => {
    ei.readOnly = true;
    ei.style.background = "#f3f4f6";
    ei.style.cursor = "not-allowed";
    ei.removeAttribute("onclick");
  });

  // -- Re-apply constraints when clause effective/expiry dates change --------
  const clauseForm =
    container.closest(".manual-clause-details-form") ||
    container.parentElement?.closest(".manual-clause-details-form");

  if (clauseForm) {
    const effInput =
      clauseForm.querySelector(".clause-effective-date") ||
      clauseForm.querySelector(
        ".form-grid .form-group:nth-child(1) input[type='date']",
      );
    const expInput =
      clauseForm.querySelector(".clause-expiry-date") ||
      clauseForm.querySelector(
        ".form-grid .form-group:nth-child(2) input[type='date']",
      );

    [effInput, expInput].forEach((inp) => {
      if (!inp) return;
      inp.addEventListener("change", () => {
        container.querySelectorAll(".conditional-fields").forEach((block) => {
          const tog = block.querySelector(".custom-step-toggle");
          if (!tog?.checked) return;
          _applyStepCycleStartConstraints(block);

          // Re-validate the start date against updated bounds
          const si = block.querySelector(".step-cycle-start-input");
          if (si && si.value) {
            const valid = _validateStepCycleStartDate(block, si);
            if (valid) _calcStepRentEndDateLocal(block);
            else {
              // Clear end date too
              const ei = block.querySelector(".step-cycle-end-input");
              if (ei) ei.value = "";
            }
          }
        });
      });
    });
  }

  // -- Deferred initialisation -----------------------------------------------
  setTimeout(() => {
    container
      .querySelectorAll(".increase-type-step-select,.custom-step-toggle")
      .forEach((el) =>
        el.dispatchEvent(new Event("change", { bubbles: true })),
      );
  }, 150);
}

// -----------------------------------------------------------------------------
// VALUE PROTECTION (CPI) - increase type toggle & custom schedule
// -----------------------------------------------------------------------------
function setupCPIIncreaseTypeToggle(container) {
  // -- Compute CPI Schedule End Date, capped to clause expiry ---------------
  function _calcCPIEndDateLocal(block) {
    const si = block.querySelector(".cpi-cycle-start-input");
    const ei = block.querySelector('[id^="cpiCycleEnd-"]');
    const fs = block.querySelector(".cpi-rent-frequency-select");

    if (!si || !ei || !fs || !si.value) return;

    // si.value is yyyy-mm-dd (native date input)
    const parts = si.value.split("-");
    if (parts.length !== 3) return;
    const d = new Date(
      parseInt(parts[0], 10),
      parseInt(parts[1], 10) - 1,
      parseInt(parts[2], 10),
    );
    if (isNaN(d.getTime())) return;

    const txt = fs.options[fs.selectedIndex]?.text.toLowerCase() || "";
    const addMonths = txt.includes("month")
      ? 1
      : txt.includes("quarter")
        ? 3
        : txt.includes("half")
          ? 6
          : txt.includes("year")
            ? 12
            : 0;

    if (!addMonths) {
      ei.value = "";
      return;
    }

    d.setMonth(d.getMonth() + addMonths);
    // End date is the last day of the period (one day before next cycle start)
    d.setDate(d.getDate() - 1);

    // Cap to clause expiry date
    const { expiryDate } = _getClauseEffectiveAndExpiryDates(block);
    if (expiryDate) {
      const expDate = new Date(expiryDate);
      expDate.setHours(0, 0, 0, 0);
      d.setHours(0, 0, 0, 0);
      if (d > expDate) {
        d.setTime(expDate.getTime());
        console.log(
          `  CPI Schedule End Date capped to clause expiry: ${expiryDate}`,
        );
      }
    }

    // Write as dd-mm-yyyy (display text input)
    ei.value = `${String(d.getDate()).padStart(2, "0")}-${String(
      d.getMonth() + 1,
    ).padStart(2, "0")}-${d.getFullYear()}`;
  }

  // -- Apply min/max on CPI Cycle Start Date from effective & expiry ---------
  function _applyCPICycleStartConstraints(block) {
    const si = block.querySelector(".cpi-cycle-start-input");
    if (!si) return;

    const { effectiveDate, expiryDate } =
      _getClauseEffectiveAndExpiryDates(block);

    if (effectiveDate) si.min = effectiveDate;
    else si.removeAttribute("min");

    if (expiryDate) si.max = expiryDate;
    else si.removeAttribute("max");
  }

  // -- Validate selected CPI Cycle Start Date --------------------------------
  function _validateCPICycleStartDate(block, input) {
    if (!input.value) return true;

    const { effectiveDate, expiryDate } =
      _getClauseEffectiveAndExpiryDates(block);
    const selected = new Date(input.value);
    selected.setHours(0, 0, 0, 0);

    if (effectiveDate) {
      const effDate = new Date(effectiveDate);
      effDate.setHours(0, 0, 0, 0);
      if (selected < effDate) {
        input.style.borderColor = "#ef4444";
        input.style.boxShadow = "0 0 0 3px rgba(239,68,68,0.15)";
        showNotification(
          " CPI 2nd Schedule Start Date cannot be before the Effective Date",
          "error",
        );
        input.value = "";
        setTimeout(() => {
          input.style.borderColor = "";
          input.style.boxShadow = "";
        }, 1500);
        return false;
      }
    }

    if (expiryDate) {
      const expDate = new Date(expiryDate);
      expDate.setHours(0, 0, 0, 0);
      if (selected > expDate) {
        input.style.borderColor = "#ef4444";
        input.style.boxShadow = "0 0 0 3px rgba(239,68,68,0.15)";
        showNotification(
          " CPI 2nd Schedule Start Date cannot be after the Expiry Date",
          "error",
        );
        input.value = "";
        setTimeout(() => {
          input.style.borderColor = "";
          input.style.boxShadow = "";
        }, 1500);
        return false;
      }
    }

    input.style.borderColor = "";
    input.style.boxShadow = "";
    return true;
  }

  // -- Main change event listener --------------------------------------------
  container.addEventListener("change", function (e) {
    const target = e.target;
    const block = target.closest(".conditional-fields") || container;

    // Increase type toggle (flat vs percentage fields)
    if (target.classList.contains("increase-type-cpi-select")) {
      const ts = block.querySelector(".increase-type-cpi-select");
      const ff = block.querySelector('[id^="cpiFlatAmountField-"]');
      const mf = block.querySelector('[id^="cpiMinFlatAmountField-"]');
      const mnp = block.querySelector('[id^="cpiMinPercentField-"]');
      const mxp = block.querySelector('[id^="cpiMaxPercentField-"]');
      if (!ts) return;
      const txt = ts.options[ts.selectedIndex]?.text.toLowerCase() || "";
      const isFlat = txt.includes("flat") || txt.includes("fixed");
      const isPercent = txt.includes("percent") || txt.includes("variable");

      if (ff) ff.style.display = isFlat ? "block" : "none";
      if (mf) mf.style.display = isFlat ? "block" : "none";
      if (mnp) mnp.style.display = isPercent ? "block" : "none";
      if (mxp) mxp.style.display = isPercent ? "block" : "none";
    }

    // Custom CPI schedule toggle
    if (target.classList.contains("custom-cpi-toggle")) {
      const tog = block.querySelector(".custom-cpi-toggle");
      const csw = block.querySelector(".cpi-cycle-start-wrapper");
      const cew = block.querySelector(".cpi-cycle-end-wrapper");
      if (csw) csw.style.display = tog?.checked ? "block" : "none";
      if (cew) cew.style.display = tog?.checked ? "block" : "none";

      if (tog?.checked) {
        setTimeout(() => {
          _applyCPICycleStartConstraints(block);
          _calcCPIEndDateLocal(block);
        }, 50);
      } else {
        // Clear both dates when custom schedule is turned off
        const si = block.querySelector(".cpi-cycle-start-input");
        const ei = block.querySelector('[id^="cpiCycleEnd-"]');
        if (si) si.value = "";
        if (ei) ei.value = "";
      }
    }

    // CPI Cycle Start Date changed - validate then compute end date
    if (target.classList.contains("cpi-cycle-start-input")) {
      const valid = _validateCPICycleStartDate(block, target);
      if (valid) _calcCPIEndDateLocal(block);
    }

    // CPI frequency changed - recompute end date if toggle is on
    if (target.classList.contains("cpi-rent-frequency-select")) {
      const tog = block.querySelector(".custom-cpi-toggle");
      if (tog?.checked) _calcCPIEndDateLocal(block);
    }

    // CPI frequency / Reference Month changed - apply Reference Month rules
    if (
      target.classList.contains("cpi-rent-frequency-select") ||
      target.classList.contains("cpi-reference-month-select")
    ) {
      _applyCpiReferenceMonthRules(block);
    }

    // Skip First CPI Schedule toggled - show/hide its info note
    if (target.classList.contains("skip-first-cpi-toggle")) {
      _syncSkipFirstCpiNote(block);
    }

    // Refresh the CPI Schedule Cycles card after dates / end date have settled
    // (the custom toggle recomputes the end date on a 50 ms timer)
    if (block.id && block.id.startsWith("cpiFields-")) {
      setTimeout(() => _updateCpiCyclesCard(block), 80);
    }
  });

  // -- Re-apply constraints when clause effective/expiry dates change --------
  const clauseForm =
    container.closest(".manual-clause-details-form") ||
    container.parentElement?.closest(".manual-clause-details-form");

  if (clauseForm) {
    const effInput =
      clauseForm.querySelector(".clause-effective-date") ||
      clauseForm.querySelector(
        ".form-grid .form-group:nth-child(1) input[type='date']",
      );
    const expInput =
      clauseForm.querySelector(".clause-expiry-date") ||
      clauseForm.querySelector(
        ".form-grid .form-group:nth-child(2) input[type='date']",
      );

    [effInput, expInput].forEach((inp) => {
      if (!inp) return;
      inp.addEventListener("change", () => {
        container.querySelectorAll(".conditional-fields").forEach((block) => {
          const tog = block.querySelector(".custom-cpi-toggle");
          if (!tog?.checked) return;
          _applyCPICycleStartConstraints(block);

          // Re-validate and recompute on bound change
          const si = block.querySelector(".cpi-cycle-start-input");
          if (si && si.value) {
            const valid = _validateCPICycleStartDate(block, si);
            if (valid) _calcCPIEndDateLocal(block);
            else {
              const ei = block.querySelector('[id^="cpiCycleEnd-"]');
              if (ei) ei.value = "";
            }
          }
        });
      });
    });
  }

  // -- Deferred initialisation -----------------------------------------------
  setTimeout(() => {
    container
      .querySelectorAll(".increase-type-cpi-select,.custom-cpi-toggle")
      .forEach((el) =>
        el.dispatchEvent(new Event("change", { bubbles: true })),
      );
    // Container is either the clause form or a single (cloned) CPI instance
    const cpiBlocks =
      container.id && container.id.startsWith("cpiFields-")
        ? [container]
        : Array.from(container.querySelectorAll("[id^='cpiFields-']"));
    cpiBlocks.forEach((block) => {
      _applyCpiReferenceMonthRules(block);
      _syncSkipFirstCpiNote(block);
      _updateCpiCyclesCard(block);
    });
  }, 150);
}

// -----------------------------------------------------------------------------
// CPI Reference Month + CPI Custom Month rules
// Mirrors handleCpiReferenceMonthVisibility on the Lease Clause form
// (leaseclausecript.js). Driven by CPI Rent Frequency:
//   no frequency           -> Reference Month hidden
//   Monthly                -> Start / Last / Latest Published (defaults to Start Month)
//   Quarterly, Half-Yearly -> Start / Last / Latest Published
//   Yearly                 -> all options; "Custom Month" reveals CPI Custom Month
// -----------------------------------------------------------------------------
const CPI_FREQ = {
  MONTHLY: 126330000,
  QUARTERLY: 126330001,
  HALF_YEARLY: 126330002,
  YEARLY: 126330003,
};
const CPI_REF = { START: 1, LAST: 2, CUSTOM: 3, LATEST: 4 };

function _applyCpiReferenceMonthRules(block) {
  const fs = block.querySelector(".cpi-rent-frequency-select");
  const refWrap = block.querySelector(".cpi-reference-month-wrapper");
  const refSel = block.querySelector(".cpi-reference-month-select");
  const custWrap = block.querySelector(".cpi-custom-month-wrapper");
  const custSel = block.querySelector(".cpi-custom-month-select");
  if (!fs || !refWrap || !refSel) return;

  const hideCustomMonth = () => {
    if (custWrap) custWrap.style.display = "none";
    if (custSel) custSel.value = "";
  };

  // No frequency selected -> hide both fields
  const freq = fs.value === "" ? NaN : parseInt(fs.value, 10);
  if (isNaN(freq)) {
    refWrap.style.display = "none";
    refSel.value = "";
    hideCustomMonth();
    return;
  }

  // Option value first; label as a fallback in case values differ per environment
  const freqLabel = (fs.options[fs.selectedIndex]?.text || "")
    .trim()
    .toLowerCase();
  const isYearly =
    freq === CPI_FREQ.YEARLY ||
    (/year|annual/.test(freqLabel) && !/half/.test(freqLabel));
  const isMonthly = freq === CPI_FREQ.MONTHLY || freqLabel === "monthly";

  const allowed = isYearly
    ? [CPI_REF.START, CPI_REF.LAST, CPI_REF.CUSTOM, CPI_REF.LATEST]
    : [CPI_REF.START, CPI_REF.LAST, CPI_REF.LATEST];

  // Rebuild the options only when the allowed set changes
  const current = refSel.value === "" ? NaN : parseInt(refSel.value, 10);
  const allowedKey = allowed.join(",");
  if (refSel.dataset.allowed !== allowedKey) {
    const map = choiceFieldMappings["array_cpireferencemonth"] || {};
    refSel.innerHTML =
      '<option value="">Select reference month</option>' +
      Object.entries(map)
        .filter(([, v]) => allowed.includes(Number(v)))
        .map(
          ([label, v]) => `<option value="${v}">${escapeHtml(label)}</option>`,
        )
        .join("");
    refSel.dataset.allowed = allowedKey;
  }

  // Keep a still-allowed selection; Monthly defaults to Start Month;
  // otherwise clear a value that is no longer offered (e.g. Custom Month)
  if (!isNaN(current) && allowed.includes(current)) {
    refSel.value = String(current);
  } else if (isMonthly) {
    refSel.value = String(CPI_REF.START);
  } else {
    refSel.value = "";
  }
  refWrap.style.display = "block";

  // Custom Month only for Yearly + Reference Month = Custom Month
  if (isYearly && refSel.value === String(CPI_REF.CUSTOM)) {
    if (custWrap) custWrap.style.display = "block";
  } else {
    hideCustomMonth();
  }
}

function _syncSkipFirstCpiNote(block) {
  const tog = block.querySelector(".skip-first-cpi-toggle");
  const note = block.querySelector(".skip-first-cpi-info");
  if (note) note.style.display = tog?.checked ? "block" : "none";
}

// -----------------------------------------------------------------------------
// CPI Schedule Cycles card (same as the Lease Clause form's info card).
// Shown when Enable Custom CPI Schedule is on:
//   1st Cycle: Effective Date -> day before the 2nd Schedule Start Date
//   2nd Cycle: 2nd Schedule Start Date -> 2nd Schedule End Date
// -----------------------------------------------------------------------------
function _updateCpiCyclesCard(block) {
  const card = block.querySelector(".cpi-schedule-cycles-info");
  if (!card) return;
  const tog = block.querySelector(".custom-cpi-toggle");
  if (!tog?.checked) {
    card.style.display = "none";
    card.innerHTML = "";
    return;
  }

  // yyyy-mm-dd -> dd/mm/yyyy
  const fmtIso = (iso) => {
    const p = String(iso || "").split("-");
    return p.length === 3 && p[0].length === 4 ? `${p[2]}/${p[1]}/${p[0]}` : "";
  };
  // yyyy-mm-dd minus one day -> dd/mm/yyyy
  const dayBefore = (iso) => {
    const p = String(iso).split("-").map(Number);
    const d = new Date(p[0], p[1] - 1, p[2]);
    d.setDate(d.getDate() - 1);
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
  };
  const hi = (t) => `<span style="color:#2563eb;">${escapeHtml(t)}</span>`;
  const tag = (t) => `<span style="color:#6b7280;">(${t})</span>`;

  const { effectiveDate } = _getClauseEffectiveAndExpiryDates(block);
  const startIso = block.querySelector(".cpi-cycle-start-input")?.value || "";
  // End date input holds dd-mm-yyyy
  const endTxt = (
    block.querySelector('[id^="cpiCycleEnd-"]')?.value || ""
  ).replace(/-/g, "/");

  let body;
  if (!startIso) {
    body = `<div style="color:#6b7280;">Select the CPI 2nd Schedule Start Date to see the cycles.</div>`;
  } else {
    const lines = [];
    // 1st cycle only when there is a gap between Effective Date and 2nd start
    if (effectiveDate && effectiveDate < startIso) {
      lines.push(
        `<li><strong>1st Cycle:</strong> ${hi(fmtIso(effectiveDate))} to ${hi(dayBefore(startIso))} ${tag("Effective Date")}</li>`,
      );
    }
    lines.push(
      `<li><strong>2nd Cycle:</strong> ${hi(fmtIso(startIso))} to ${hi(endTxt || "-")} ${tag("Custom Schedule")}</li>`,
    );
    body = `<ul style="margin:0;padding-left:18px;">${lines.join("")}</ul>`;
  }

  card.innerHTML = `<div style="font-weight:600;margin-bottom:4px;">&#9432; CPI Schedule Cycles</div>${body}`;
  card.style.display = "block";
}

function _calcCPIEndDate(block) {
  const si = block.querySelector(".cpi-cycle-start-input");
  const ei = block.querySelector('[id^="cpiCycleEnd-"]');
  const fs = block.querySelector(".cpi-rent-frequency-select");
  if (!si || !ei || !fs || !si.value) return;
  // Native date input (type="date") returns yyyy-mm-dd
  const parts = si.value.split("-");
  if (parts.length !== 3) return;
  const d = new Date(
    parseInt(parts[0], 10),
    parseInt(parts[1], 10) - 1,
    parseInt(parts[2], 10),
  );
  if (isNaN(d.getTime())) return;
  const txt = fs.options[fs.selectedIndex]?.text.toLowerCase() || "";
  const add = txt.includes("month")
    ? 1
    : txt.includes("quarter")
      ? 3
      : txt.includes("half")
        ? 6
        : txt.includes("year")
          ? 12
          : 0;
  if (add) {
    d.setMonth(d.getMonth() + add);
    ei.value = `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}`;
  }
}

// -----------------------------------------------------------------------------
// TURNOVER RENT - setup interactivity
// -----------------------------------------------------------------------------
function setupTurnoverRentInteractivity(container) {
  // Periodic cycle order map (lower index = more frequent)
  const PERIODIC_CYCLE_ORDER = {
    126330000: 0, // Monthly
    126330001: 1, // Quarterly
    126330002: 2, // Half-Yearly
    126330003: 3, // Yearly
  };

  // -- Increase-type visibility (flat vs percentage fields) -----------------
  function _applyIncreaseTypeVisibility(block, selectEl) {
    const txt =
      selectEl.options[selectEl.selectedIndex]?.text.toLowerCase() || "";
    const val = selectEl.value;
    const isPct =
      val === "126330001" || txt.includes("percent") || txt.includes("%");
    const isFlat =
      !isPct &&
      (txt.includes("flat") || txt.includes("fixed") || txt.includes("amount"));

    const flatAmountW = block.querySelector(".turnover-flat-amount-wrapper");
    const minSalesFlatW = block.querySelector(
      ".turnover-min-sales-flat-wrapper",
    );
    const rateW = block.querySelector(".turnover-rate-wrapper");
    const minPctW = block.querySelector(".turnover-min-pct-wrapper");

    if (flatAmountW) flatAmountW.style.display = isFlat ? "block" : "none";
    if (minSalesFlatW) minSalesFlatW.style.display = isFlat ? "block" : "none";
    if (rateW) rateW.style.display = isPct ? "block" : "none";
    if (minPctW) minPctW.style.display = isPct ? "block" : "none";
  }

  // -- OCR lock: forces Basis = "Total Sales", locks Increase Type = Percentage
  function _applyBasisLock(block, ocr) {
    const basisSel = block.querySelector(".turnover-basis-select");
    if (!basisSel) return;

    if (ocr) {
      let totalSalesValue = "";
      for (let i = 0; i < basisSel.options.length; i++) {
        if (basisSel.options[i].text.toLowerCase().includes("total sales")) {
          totalSalesValue = basisSel.options[i].value;
          break;
        }
      }
      if (totalSalesValue) basisSel.value = totalSalesValue;
      basisSel.disabled = true;
      basisSel.style.background = "#f3f4f6";
      basisSel.style.cursor = "not-allowed";
      basisSel.style.opacity = "0.7";
      basisSel.title = "Locked to Total Sales when OCR is enabled";
    } else {
      basisSel.disabled = false;
      basisSel.style.background = "";
      basisSel.style.cursor = "";
      basisSel.style.opacity = "";
      basisSel.title = "";
    }
  }

  // -- Filter reporting-cycle options so they cannot exceed settlement cycle --
  function _applyReportingCycleFilter(block) {
    const settlSel = block.querySelector(".turnover-settlement-select");
    const repSel = block.querySelector(".turnover-reporting-select");
    if (!settlSel || !repSel) return;

    const settlVal = settlSel.value;
    const settlOrder = PERIODIC_CYCLE_ORDER[settlVal];

    if (settlVal === "" || settlOrder === undefined) {
      Array.from(repSel.options).forEach((opt) => {
        opt.disabled = false;
        opt.style.color = "";
      });
      return;
    }

    const currentRepVal = repSel.value;
    let needsReset = false;

    Array.from(repSel.options).forEach((opt) => {
      if (!opt.value) return;
      const repOrder = PERIODIC_CYCLE_ORDER[opt.value];
      if (repOrder === undefined) return;

      if (repOrder > settlOrder) {
        opt.disabled = true;
        opt.style.color = "#c0c0c0";
        if (opt.value === currentRepVal) needsReset = true;
      } else {
        opt.disabled = false;
        opt.style.color = "";
      }
    });

    if (needsReset) {
      repSel.value = "";
      repSel.style.borderColor = "#f59e0b";
      repSel.style.boxShadow = "0 0 0 3px rgba(245,158,11,0.15)";
      showNotification(
        "  Reporting Cycle was reset - it cannot exceed the Settlement Cycle",
        "warning",
      );
      setTimeout(() => {
        repSel.style.borderColor = "";
        repSel.style.boxShadow = "";
      }, 2000);
    }
  }

  // -- Validate reporting cycle on direct user selection --------------------
  function _validateReportingCycle(block) {
    const settlSel = block.querySelector(".turnover-settlement-select");
    const repSel = block.querySelector(".turnover-reporting-select");
    if (!settlSel || !repSel || !settlSel.value || !repSel.value) return true;

    const settlOrder = PERIODIC_CYCLE_ORDER[settlSel.value];
    const repOrder = PERIODIC_CYCLE_ORDER[repSel.value];
    if (settlOrder === undefined || repOrder === undefined) return true;

    if (repOrder > settlOrder) {
      repSel.style.borderColor = "#ef4444";
      repSel.style.boxShadow = "0 0 0 3px rgba(239,68,68,0.15)";
      showNotification(
        " Reporting Cycle cannot be less frequent than the Settlement Cycle",
        "error",
      );
      repSel.value = "";
      setTimeout(() => {
        repSel.style.borderColor = "";
        repSel.style.boxShadow = "";
      }, 1500);
      return false;
    }

    repSel.style.borderColor = "";
    repSel.style.boxShadow = "";
    return true;
  }

  // -- Get effective & expiry from clause form (wrapper around this block) ---
  function _getTurnoverClauseDates(block) {
    return _getClauseEffectiveAndExpiryDates(block);
  }

  // -- Apply min/max constraints to Turnover Cycle Start Date ----------------
  //    Rule: must be on or between Effective Date and Expiry Date
  function _applyTurnoverCycleStartConstraints(block) {
    const si = block.querySelector(".turnover-start-input");
    if (!si) return;

    const { effectiveDate, expiryDate } = _getTurnoverClauseDates(block);

    if (effectiveDate) si.min = effectiveDate;
    else si.removeAttribute("min");

    if (expiryDate) si.max = expiryDate;
    else si.removeAttribute("max");
  }

  // -- Validate selected Turnover Cycle Start Date ---------------------------
  function _validateTurnoverCycleStartDateLocal(block, input) {
    if (!input.value) return true;

    const { effectiveDate, expiryDate } = _getTurnoverClauseDates(block);
    const selected = new Date(input.value);
    selected.setHours(0, 0, 0, 0);

    if (effectiveDate) {
      const effDate = new Date(effectiveDate);
      effDate.setHours(0, 0, 0, 0);
      if (selected < effDate) {
        input.style.borderColor = "#ef4444";
        input.style.boxShadow = "0 0 0 3px rgba(239,68,68,0.15)";
        showNotification(
          " Turnover Cycle Start Date cannot be before the Effective Date",
          "error",
        );
        input.value = "";
        setTimeout(() => {
          input.style.borderColor = "";
          input.style.boxShadow = "";
        }, 1500);
        return false;
      }
    }

    if (expiryDate) {
      const expDate = new Date(expiryDate);
      expDate.setHours(0, 0, 0, 0);
      if (selected > expDate) {
        input.style.borderColor = "#ef4444";
        input.style.boxShadow = "0 0 0 3px rgba(239,68,68,0.15)";
        showNotification(
          " Turnover Cycle Start Date cannot be after the Expiry Date",
          "error",
        );
        input.value = "";
        setTimeout(() => {
          input.style.borderColor = "";
          input.style.boxShadow = "";
        }, 1500);
        return false;
      }
    }

    input.style.borderColor = "";
    input.style.boxShadow = "";
    return true;
  }

  // -- Compute Turnover Cycle End Date, capped to clause expiry -------------
  function _computeTurnoverEndDateLocal(block) {
    const si = block.querySelector(".turnover-start-input");
    const ei = block.querySelector(".turnover-end-input");
    const fs = block.querySelector(".turnover-settlement-select");

    if (!si || !ei || !fs || !si.value) return;

    const d = new Date(si.value);
    if (isNaN(d.getTime())) return;

    const txt = fs.options[fs.selectedIndex]?.text.toLowerCase() || "";
    const addMonths = txt.includes("month")
      ? 1
      : txt.includes("quarter")
        ? 3
        : txt.includes("half")
          ? 6
          : txt.includes("year")
            ? 12
            : 0;

    if (!addMonths) {
      ei.value = "";
      return;
    }

    d.setMonth(d.getMonth() + addMonths);
    d.setDate(d.getDate() - 1); // last day of the period

    // Cap to clause expiry date
    const { expiryDate } = _getTurnoverClauseDates(block);
    if (expiryDate) {
      const expDate = new Date(expiryDate);
      expDate.setHours(0, 0, 0, 0);
      d.setHours(0, 0, 0, 0);
      if (d > expDate) {
        d.setTime(expDate.getTime());
        console.log(
          `  Turnover Cycle End Date capped to clause expiry: ${expiryDate}`,
        );
      }
    }

    // Write as yyyy-mm-dd for type="date" input
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    ei.value = `${yyyy}-${mm}-${dd}`;
  }

  // -- Main change-event listener --------------------------------------------
  container.addEventListener("change", function (e) {
    const block = e.target.closest(".conditional-fields") || container;

    // VAT toggle
    if (e.target.classList.contains("vat-toggle")) {
      const on = e.target.checked;
      block.querySelectorAll(".vat-conditional-field").forEach((f) => {
        f.style.display = on ? "block" : "none";
      });
    }

    // OCR toggle
    if (e.target.classList.contains("ocr-toggle")) {
      const ocr = e.target.checked;
      const els = {
        it: block.querySelector(".turnover-increase-wrapper"),
        ms: block.querySelector(".max-sales-wrapper"),
        sc: block.querySelector(".secondary-charge-wrapper"),
      };
      if (els.it) els.it.style.display = "block";
      if (els.ms) els.ms.style.display = ocr ? "none" : "block";
      if (els.sc) els.sc.style.display = ocr ? "block" : "none";

      _applyBasisLock(block, ocr);

      const incSel = block.querySelector(".turnover-increase-select");
      if (incSel) {
        if (ocr) {
          incSel.value = "126330001"; // Percentage
          incSel.disabled = true;
          incSel.style.background = "#f3f4f6";
          incSel.style.cursor = "not-allowed";
          incSel.title = "Locked to Percentage when OCR is enabled";
        } else {
          incSel.disabled = false;
          incSel.style.background = "";
          incSel.style.cursor = "";
          incSel.title = "";
        }
        _applyIncreaseTypeVisibility(block, incSel);
      }

      // Minimum Turnover Percentage becomes mandatory when OCR is enabled
      const minPctLabel = block.querySelector(
        ".turnover-min-pct-wrapper label",
      );
      if (minPctLabel) {
        const hasStar = minPctLabel.querySelector(".ocr-required-star");
        if (ocr && !hasStar) {
          minPctLabel.insertAdjacentHTML(
            "beforeend",
            ' <span class="ocr-required-star" style="color:red;">*</span>',
          );
        } else if (!ocr && hasStar) {
          hasStar.remove();
        }
      }
    }

    // Increase-type changed
    if (e.target.classList.contains("turnover-increase-select")) {
      _applyIncreaseTypeVisibility(block, e.target);
    }

    // Settlement cycle changed - filter reporting + recompute end date
    if (e.target.classList.contains("turnover-settlement-select")) {
      _applyReportingCycleFilter(block);
      const tog = block.querySelector(".custom-turnover-toggle");
      if (tog?.checked) _computeTurnoverEndDateLocal(block);
    }

    // Reporting cycle changed - validate immediately
    if (e.target.classList.contains("turnover-reporting-select")) {
      _validateReportingCycle(block);
    }

    // Custom schedule toggle
    if (e.target.classList.contains("custom-turnover-toggle")) {
      const tog = e.target;
      const sw = block.querySelector(".turnover-start-wrapper");
      const ew = block.querySelector(".turnover-end-wrapper");
      if (sw) sw.style.display = tog.checked ? "block" : "none";
      if (ew) ew.style.display = tog.checked ? "block" : "none";

      if (tog.checked) {
        // Apply date constraints AFTER wrapper is visible
        setTimeout(() => {
          _applyTurnoverCycleStartConstraints(block);
          _computeTurnoverEndDateLocal(block);
        }, 50);
      } else {
        // Clear both dates when custom schedule is disabled
        const si = block.querySelector(".turnover-start-input");
        const ei = block.querySelector(".turnover-end-input");
        if (si) si.value = "";
        if (ei) ei.value = "";
      }
    }

    // Turnover cycle start date changed - validate then compute end date
    if (e.target.classList.contains("turnover-start-input")) {
      const valid = _validateTurnoverCycleStartDateLocal(block, e.target);
      if (valid) _computeTurnoverEndDateLocal(block);
    }
  });

  // -- React to clause effective/expiry date changes -------------------------
  const clauseForm =
    container.closest(".manual-clause-details-form") ||
    container.parentElement?.closest(".manual-clause-details-form");

  if (clauseForm) {
    const effInput =
      clauseForm.querySelector(".clause-effective-date") ||
      clauseForm.querySelector(
        ".form-grid .form-group:nth-child(1) input[type='date']",
      );
    const expInput =
      clauseForm.querySelector(".clause-expiry-date") ||
      clauseForm.querySelector(
        ".form-grid .form-group:nth-child(2) input[type='date']",
      );

    [effInput, expInput].forEach((inp) => {
      if (!inp) return;
      inp.addEventListener("change", () => {
        container.querySelectorAll(".conditional-fields").forEach((block) => {
          const tog = block.querySelector(".custom-turnover-toggle");
          if (!tog?.checked) return;
          _applyTurnoverCycleStartConstraints(block);

          // Re-validate and recompute on bound change
          const si = block.querySelector(".turnover-start-input");
          if (si && si.value) {
            const valid = _validateTurnoverCycleStartDateLocal(block, si);
            if (valid) _computeTurnoverEndDateLocal(block);
            else {
              const ei = block.querySelector(".turnover-end-input");
              if (ei) ei.value = "";
            }
          }
        });
        // Also handle the top-level container itself (single-instance)
        const tog = container.querySelector(".custom-turnover-toggle");
        if (tog?.checked) {
          _applyTurnoverCycleStartConstraints(container);
          const si = container.querySelector(".turnover-start-input");
          if (si && si.value) {
            const valid = _validateTurnoverCycleStartDateLocal(container, si);
            if (valid) _computeTurnoverEndDateLocal(container);
            else {
              const ei = container.querySelector(".turnover-end-input");
              if (ei) ei.value = "";
            }
          }
        }
      });
    });
  }

  // -- Deferred initialisation -----------------------------------------------
  setTimeout(() => {
    const block = container.querySelector(".conditional-fields") || container;

    // Auto-select PLN as default currency
    const currSel = block.querySelector(".currency-select");
    if (currSel && !currSel.value) {
      if (window.currencies && window.currencies.length) {
        const pln = window.currencies.find(
          (c) => c.isocurrencycode && c.isocurrencycode.toUpperCase() === "PLN",
        );
        if (pln) currSel.value = pln.transactioncurrencyid;
      } else {
        for (let i = 0; i < currSel.options.length; i++) {
          if (currSel.options[i].text.toUpperCase().includes("PLN")) {
            currSel.selectedIndex = i;
            break;
          }
        }
      }
    }

    // Apply initial reporting cycle filter
    _applyReportingCycleFilter(block);

    // Trigger initial visibility for all toggles/selects
    container
      .querySelectorAll(
        ".ocr-toggle,.custom-turnover-toggle,.vat-toggle,.turnover-increase-select",
      )
      .forEach((el) =>
        el.dispatchEvent(new Event("change", { bubbles: true })),
      );
  }, 150);
}

// ---- Capture clause data from manual mode forms ----
async function captureManualClauseData() {
  const clauses = [];
  document
    .querySelectorAll(".manual-clause-item-wrapper")
    .forEach((wrapper) => {
      const checkbox = wrapper.querySelector('input[type="checkbox"]');
      if (!checkbox?.checked) return;
      const clauseType = checkbox.getAttribute("data-clause-type");
      const safeType = checkbox.getAttribute("data-safe-type");
      const form = wrapper.querySelector(".manual-clause-details-form");
      if (!form) return;
      // Clause-level dates only exist for single-form (header-date) clause
      // types. Instance-based types carry dates per instance (captured below).
      const eff = getInputValue(
        form,
        ".clause-header-dates .clause-effective-date",
      );
      const exp = getInputValue(
        form,
        ".clause-header-dates .clause-expiry-date",
      );
      const clauseData = {
        clauseType,
        safeType,
        description: getTextareaValue(form, "textarea"),
      };
      if (eff) clauseData.effectiveDate = eff;
      if (exp) clauseData.expiryDate = exp;
      const specific = captureClauseSpecificDataFromForm(
        form,
        clauseType,
        safeType,
      );
      clauses.push({ ...clauseData, ...specific });
    });
  // Attach clauses to units - if safeId is empty (global mode), all clauses apply to all units
  if (window._clauseDocumentUnits) {
    window._clauseDocumentUnits.forEach((unit) => {
      if (!unit.safeId) {
        unit.clauses = clauses; // global mode: all clauses apply
      } else {
        unit.clauses = clauses.filter(
          (c) => c.safeType && c.safeType.split("_").pop() === unit.safeId,
        );
      }
    });
  }
  return clauses;
}

function captureClauseSpecificDataFromForm(form, clauseType, safeType) {
  const data = {};
  switch (clauseType) {
    case "Step Rent Indexation": {
      const instances = form.querySelectorAll("[id^='stepRentFields-']");
      if (!instances.length) break;
      data.stepRentInstances = [];
      instances.forEach((block) => {
        const inst = { stepRentEnabled: true };
        const _ie = block.querySelector(".clause-effective-date")?.value;
        const _ix = block.querySelector(".clause-expiry-date")?.value;
        if (_ie) inst.effectiveDate = _ie;
        if (_ix) inst.expiryDate = _ix;
        const ct = block.querySelector(".charge-type-step-select");
        if (ct?.value) inst.chargeTypeStepIncrease = ct.value;
        const it = block.querySelector("select[id^='increaseType-']");
        if (it?.value) {
          inst.increaseType = it.value;
          const txt = it.options[it.selectedIndex].text.toLowerCase();
          if (txt.includes("flat")) {
            const fi = block.querySelector("[id^='flatField-'] input");
            if (fi?.value) inst.flatAmount = fi.value;
          } else if (txt.includes("percent")) {
            const pi = block.querySelector("[id^='percentField-'] input");
            if (pi?.value) inst.stepRentPercentage = pi.value;
          }
        }
        const fs = block.querySelector(".step-rent-frequency-select");
        if (fs?.value) inst.stepRentFrequency = fs.value;
        const tog = block.querySelector(".custom-step-toggle");
        if (tog) {
          inst.enableCustomStepRentSchedule = tog.checked;
          if (tog.checked) {
            const cs = block.querySelector(".step-cycle-start-input");
            const ce = block.querySelector(".step-cycle-end-input");
            if (cs?.value) inst.stepRentCycleStartDate = cs.value;
            if (ce?.value) inst.stepRentCycleEndDate = ce.value;
          }
        }
        const sm = block.querySelector(".step-clause-summary");
        if (sm?.value) {
          inst.clauseSummary = sm.value;
          inst.description = sm.value;
        }
        data.stepRentInstances.push(inst);
      });
      break;
    }

    case "Value Protection (CPI)": {
      const instances = form.querySelectorAll("[id^='cpiFields-']");
      if (!instances.length) break;
      data.cpiInstances = [];
      instances.forEach((block) => {
        const inst = { indexationEnabled: true };
        const _ie = block.querySelector(".clause-effective-date")?.value;
        const _ix = block.querySelector(".clause-expiry-date")?.value;
        if (_ie) inst.effectiveDate = _ie;
        if (_ix) inst.expiryDate = _ix;

        // Current Index - has a unique id
        const ci = block.querySelector("input[id^='currentIndexInput-']");
        if (ci?.value) inst.currentIndex = ci.value;

        // FIX 1: Initial Waiting Period - use unique class instead of fragile nth-child selector
        const iwp = block.querySelector(".initial-waiting-period-input");
        if (iwp?.value) inst.initialWaitingPeriod = iwp.value;

        const ct = block.querySelector(".charge-type-cpi-select");
        if (ct?.value) inst.chargeTypeCPI = ct.value;

        const its = block.querySelector(".increase-type-cpi-select");
        if (its?.value) {
          inst.increaseTypeCPI = its.value;
          const txt = its.options[its.selectedIndex].text.toLowerCase();
          if (txt.includes("flat") || txt.includes("fixed")) {
            const fi = block.querySelector("[id^='cpiFlatAmountField-'] input");
            if (fi?.value) inst.flatAmountCPI = fi.value;
            // FIX 4: Use consistent property name minimumIncreaseFlatAmountCPI
            const mfi = block.querySelector(
              "[id^='cpiMinFlatAmountField-'] input",
            );
            if (mfi?.value) inst.minimumIncreaseFlatAmountCPI = mfi.value;
          } else if (txt.includes("percent") || txt.includes("variable")) {
            const mn = block.querySelector("[id^='cpiMinPercentField-'] input");
            const mx = block.querySelector("[id^='cpiMaxPercentField-'] input");
            if (mn?.value) inst.minimumIncreasePercentage = mn.value;
            if (mx?.value) inst.maximumIncreasePercentage = mx.value;
          }
        }

        // FIX 2: Minimum Time Interval - use unique class (was colliding with Initial Waiting Period)
        const mti = block.querySelector(".min-time-interval-input");
        if (mti?.value) inst.minimumTimeInterval = mti.value;

        // FIX 3: Trigger Value - use unique class (was colliding with min/max percent inputs)
        const tv = block.querySelector(".trigger-value-input");
        if (tv?.value) inst.triggerValue = tv.value;

        // CPI Type select - exclude named selects to isolate the CPI Type dropdown
        const allSel = block.querySelectorAll(
          "select:not(.increase-type-cpi-select):not(.charge-type-cpi-select):not(.cpi-rent-frequency-select)",
        );
        if (allSel[0]?.value) inst.cpiType = allSel[0].value;

        const fs = block.querySelector(".cpi-rent-frequency-select");
        if (fs?.value) inst.cpiRentFrequency = fs.value;

        // CPI Reference Month / Custom Month / Skip First CPI Schedule
        const rms = block.querySelector(".cpi-reference-month-select");
        if (rms?.value) inst.cpiReferenceMonth = rms.value;
        const cms = block.querySelector(".cpi-custom-month-select");
        if (cms?.value && String(inst.cpiReferenceMonth) === String(CPI_REF.CUSTOM))
          inst.cpiCustomMonth = cms.value;
        const sft = block.querySelector(".skip-first-cpi-toggle");
        if (sft) inst.skipFirstCPISchedule = sft.checked;

        const tog = block.querySelector(".custom-cpi-toggle");
        if (tog) {
          inst.enableCustomCPISchedule = tog.checked;
          if (tog.checked) {
            const cs = block.querySelector(".cpi-cycle-start-input");
            const ce = block.querySelector("[id^='cpiCycleEnd-']");
            if (cs?.value) inst.cpiScheduleStartDate = cs.value;
            if (ce?.value) inst.cpiScheduleEndDate = ce.value;
          }
        }

        const sm = block.querySelector(".cpi-clause-summary");
        if (sm?.value) inst.clauseSummary = sm.value;

        data.cpiInstances.push(inst);
      });
      break;
    }

    case "Turnover Rent": {
      const instances = form.querySelectorAll("[id^='turnoverFields-']");
      if (!instances.length) break;
      data.turnoverInstances = [];
      instances.forEach((block) => {
        const inst = { turnoverRentEnabled: true };
        const _ie = block.querySelector(".clause-effective-date")?.value;
        const _ix = block.querySelector(".clause-expiry-date")?.value;
        if (_ie) inst.effectiveDate = _ie;
        if (_ix) inst.expiryDate = _ix;

        const vt = block.querySelector(".vat-toggle");
        if (vt) {
          inst.subjectToVAT = vt.checked;
          if (vt.checked) {
            inst.vat = getSelectValue(block, ".vat-select");
          }
        }

        const ocr = block.querySelector(".ocr-toggle");
        if (ocr) inst.enableOCR = ocr.checked;
        const pro = block.querySelector(".proration-toggle");
        if (pro) inst.enableProration = pro.checked;
        const ctt = block.querySelector(".custom-turnover-toggle");
        if (ctt) {
          inst.enableCustomTurnoverSchedule = ctt.checked;
          if (ctt.checked) {
            inst.turnoverCycleStartDate = getInputValue(
              block,
              ".turnover-start-input",
            );
            inst.turnoverCycleEndDate = getInputValue(
              block,
              ".turnover-end-input",
            );
          }
        }
        inst.currency = getSelectValue(block, ".currency-select");
        inst.turnoverRentBasis = getSelectValue(
          block,
          ".turnover-basis-select",
        );
        inst.chargeTypeTurnover = getSelectValue(
          block,
          ".charge-type-turnover-select",
        );
        inst.settlementCycle = getSelectValue(
          block,
          ".turnover-settlement-select",
        );
        inst.reportingCycle = getSelectValue(
          block,
          ".turnover-reporting-select",
        );
        inst.turnoverRentCalculationType = getSelectValue(
          block,
          ".turnover-calc-type-select",
        );

        const incSel = block.querySelector(".turnover-increase-select");
        if (incSel?.value) {
          inst.increaseTypeTurnover = incSel.value;
          const incTxt =
            incSel.options[incSel.selectedIndex]?.text.toLowerCase() || "";
          const incVal = incSel.value;
          const isPct =
            incVal === "126330001" ||
            incTxt.includes("percent") ||
            incTxt.includes("%");
          const isFlat =
            !isPct &&
            (incTxt.includes("flat") ||
              incTxt.includes("fixed") ||
              incTxt.includes("amount"));
          if (isFlat) {
            const fa = getInputValue(block, ".turnover-flat-amount-input");
            if (fa) inst.flatAmountTurnoverRent = fa;
            const ms = getInputValue(block, ".min-sales-input");
            if (ms) inst.minSalesRentAmount = ms;
          } else if (isPct) {
            const tr = getInputValue(block, ".turnover-rate-input");
            if (tr) inst.turnoverRate = tr;
            const mp = getInputValue(block, ".turnover-min-pct-input");
            if (mp) inst.minimumTurnoverPercentage = mp;
          }
        }
        inst.salesThreshold = getInputValue(block, ".sales-threshold-input");
        if (inst.enableOCR) {
          inst.secondaryChargeTypeTurnover = getSelectValue(
            block,
            ".secondary-charge-type-select",
          );
        }
        const sm = block.querySelector(".turnover-clause-summary");
        if (sm?.value) {
          inst.clauseSummary = sm.value;
          inst.description = sm.value;
        }
        data.turnoverInstances.push(inst);
      });
      break;
    }
  }
  return data;
}

// ---- Add/Remove clause instances ----
window.addClauseInstance = function (button, type) {
  const blocks = document.querySelectorAll(`[id^='${type}Fields-']`);
  if (blocks.length >= 10) {
    alert("You can only add up to 10 instances.");
    return;
  }
  const current = button.closest(".conditional-fields");
  if (!current) return;
  const clone = current.cloneNode(true);
  clone.id = current.id + "_copy_" + Date.now();
  clone.querySelectorAll("input,select,textarea").forEach((el) => {
    if (el.type === "checkbox" || el.type === "radio") el.checked = false;
    else el.value = "";
  });

  const cab = clone.querySelector(".add-instance-btn");
  if (cab) cab.remove();
  const caa = current.querySelector(".add-instance-btn");
  if (caa) caa.remove();

  // Ensure the ORIGINAL instance gets a remove button when it gains a sibling
  // (the turnover template has no remove button on instance 1 unlike step rent/CPI)
  if (!current.querySelector(".remove-instance-btn")) {
    const rbOrig = document.createElement("button");
    rbOrig.type = "button";
    rbOrig.className = "remove-instance-btn";
    rbOrig.innerText = "Remove";
    rbOrig.onclick = function () {
      removeClauseInstance(this, type);
    };
    current.insertBefore(rbOrig, current.firstChild);
  }

  // Ensure the CLONE has a remove button with a working onclick.
  // cloneNode(true) copies HTML onclick attributes but NOT JS .onclick property
  // handlers - so clones of dynamically-created remove buttons lose their handler.
  let cloneRemoveBtn = clone.querySelector(".remove-instance-btn");
  if (!cloneRemoveBtn) {
    cloneRemoveBtn = document.createElement("button");
    cloneRemoveBtn.type = "button";
    cloneRemoveBtn.className = "remove-instance-btn";
    cloneRemoveBtn.innerText = "Remove";
    clone.insertBefore(cloneRemoveBtn, clone.firstChild);
  }
  // Always re-assign onclick regardless - this is the critical fix for cloned instances
  cloneRemoveBtn.onclick = function () {
    removeClauseInstance(this, type);
  };

  current.after(clone);

  const all = document.querySelectorAll(`[id^='${type}Fields-']`);
  const last = all[all.length - 1];
  if (last && !last.querySelector(".add-instance-btn")) {
    const ab = document.createElement("button");
    ab.type = "button";
    ab.className = "add-instance-btn";
    ab.innerText =
      type === "stepRent"
        ? "+ Add another step"
        : type === "cpi"
          ? "+ Add another CPI instance"
          : "+ Add another turnover configuration";
    ab.onclick = function () {
      addClauseInstance(this, type);
    };
    last.appendChild(ab);
  }
  setTimeout(() => {
    // New instances default their Effective/Expiry dates to the lease term
    // (the clone-clear above blanks them). User can override per instance.
    const _sd = document.getElementById("startDate")?.value || "";
    const _ed = document.getElementById("endDate")?.value || "";
    const cEff = clone.querySelector(".clause-effective-date");
    const cExp = clone.querySelector(".clause-expiry-date");
    // cloneNode copies the dateWired guard flag - clear it so the clone re-wires.
    if (cEff) delete cEff.dataset.dateWired;
    if (cEff && _sd) cEff.value = _sd;
    if (cExp) {
      if (_sd) cExp.min = _sd;
      if (_ed) cExp.value = _ed;
    }
    _setupClauseDateValidation(clone);

    initializeDatePickers(clone);
    if (type === "stepRent") setupStepRentInteractivity(clone);
    else if (type === "cpi") {
      setupCPIIncreaseTypeToggle(clone);
      const ci = clone.querySelector('input[id^="currentIndexInput-"]');
      if (ci)
        getCurrentMonthCPIIndex().then((v) => {
          if (v !== null) ci.value = v;
        });
    } else if (type === "turnover") setupTurnoverRentInteractivity(clone);
  }, 100);
  _updateInstanceTitles(type);
};

window.removeClauseInstance = function (button, type) {
  // Find the parent .conditional-fields block by walking up from the button
  const block = button.closest(".conditional-fields");
  if (!block) {
    console.warn(
      "removeClauseInstance: could not find parent .conditional-fields block",
    );
    return;
  }

  // Count all sibling blocks of the same type within the same wrapper
  const wrapper = block.parentElement;
  const allBlocks = Array.from(
    wrapper.querySelectorAll(":scope > .conditional-fields"),
  );

  const typeLabel =
    type === "stepRent"
      ? "Step Rent Indexation"
      : type === "cpi"
        ? "Value Protection (CPI)"
        : "Turnover Rent";

  if (allBlocks.length <= 1) {
    // Only one instance left - ask user if they want to uncheck/remove the whole clause
    showDeleteConfirm(
      "Remove Clause",
      `This is the last "${typeLabel}" instance. Removing it will uncheck and collapse the entire clause. Do you want to continue?`,
      () => {
        // Find the clause wrapper and uncheck the checkbox
        const clauseItemWrapper = wrapper.closest(
          ".manual-clause-item-wrapper",
        );
        if (clauseItemWrapper) {
          const checkbox = clauseItemWrapper.querySelector(
            'input[type="checkbox"]',
          );
          const detailsForm = clauseItemWrapper.querySelector(
            ".manual-clause-details-form",
          );

          if (checkbox && checkbox.checked) {
            checkbox.checked = false;
            // Drives the change handler -> hides the panel + deselects its card.
            checkbox.dispatchEvent(new Event("change"));
            clauseItemWrapper.classList.remove("expanded");
          }

          if (detailsForm) {
            detailsForm.style.display = "none";
          }
        }

        showNotification(` "${typeLabel}" clause has been removed`, "success");
      },
    );
    return;
  }

  // More than one instance - confirm before removing
  showDeleteConfirm(
    "Remove Instance",
    `Are you sure you want to remove this "${typeLabel}" instance?`,
    () => {
      block.remove();

      // Re-query after removal
      const remaining = Array.from(
        wrapper.querySelectorAll(":scope > .conditional-fields"),
      );

      // Remove all existing "add" buttons then add one only to the last block
      remaining.forEach((b) => {
        b.querySelectorAll(".add-instance-btn").forEach((btn) => btn.remove());
      });

      const last = remaining[remaining.length - 1];
      if (last) {
        const ab = document.createElement("button");
        ab.type = "button";
        ab.className = "add-instance-btn";
        ab.innerText = "+ Add more";
        ab.style.cssText =
          "margin-top:8px;background:var(--blue);color:white;border:none;border-radius:6px;padding:6px 14px;cursor:pointer;font-size:13px;";
        ab.onclick = function () {
          addClauseInstance(this, type);
        };
        last.appendChild(ab);
      }

      _updateInstanceTitles(type);
      showNotification(` "${typeLabel}" instance removed`, "success");
    },
  );
};

function _updateInstanceTitles(type) {
  document.querySelectorAll(`[id^='${type}Fields-']`).forEach((block, idx) => {
    let t = block.querySelector(".instance-title");
    if (!t) {
      t = document.createElement("div");
      t.className = "instance-title";
      t.style.cssText =
        "font-weight:600;font-size:13px;color:#374151;margin-bottom:8px;";
      block.insertBefore(t, block.firstChild);
    }
    t.innerText = `Instance ${idx + 1}`;
  });
}

// ---- Dataverse field map for clause record creation ----
const ClauseFieldMap = {
  stepRentEnabled: "array_steprent",
  enableCustomStepRentSchedule: "array_enablecustomsteprentschedule",
  stepRentCycleStartDate: "array_steprentcyclestartdate",
  stepRentCycleEndDate: "array_steprentcycleenddate",
  stepRentStartDate: "array_steprentstartdate",
  stepRentEndDate: "array_steprentenddate",
  increaseType: "array_increasetype",
  flatAmount: "array_flatamount",
  stepRentPercentage: "array_steprentpercentage",
  stepRentFrequency: "array_steprentfrequency",
  chargeTypeStepIncrease: "array_chargetypestepincrease",
  clauseSummary: "array_clausesummary",
  subjectToVAT: "array_subjecttovat",
  vat: "array_vat",
  taxIncluded: "array_taxincluded",
  turnoverRentEnabled: "array_turnoverrent",
  enableOCR: "array_enableocr",
  turnoverRentBasis: "array_turnoverrentbasis",
  salesThreshold: "array_salesthreshold",
  currency: "transactioncurrencyid",
  chargeTypeTurnover: "array_chargetypeturnoverrent",
  secondaryChargeTypeTurnover:
    "array_secondarychargetypeforadvanceturnoverrent",
  settlementCycle: "array_settlementcycle",
  enableCustomTurnoverSchedule: "array_enablecustomturnoverschedule",
  turnoverCycleStartDate: "array_turnovercyclestartdate",
  turnoverCycleEndDate: "array_turnovercycleenddate",
  enableProration: "array_enableprorationturnoverrent",
  reportingCycle: "array_reportingcycle",
  turnoverRentCalculationType: "array_turnoverrentcalculationtype",
  increaseTypeTurnover: "array_increasetypeturnoverrent",
  flatAmountTurnoverRent: "array_flatamountturnoverrent",
  minSalesRentAmount: "array_minimumsalesbasedrentamount",
  maxSalesRentAmount: "array_maximumsalesbasedrentamount",
  turnoverRate: "array_turnoverrate",
  minimumTurnoverPercentage: "array_minimumturnoverpercentage",
  currentIndex: "array_currentindex",
  initialWaitingPeriod: "array_initialwaitingperiodmonths",
  increaseTypeCPI: "array_increasetypecpirentprocess",
  cpiScheduleStartDate: "array_cpischedulestartdate",
  cpiScheduleEndDate: "array_cpischeduleenddate",
  minimumTimeInterval: "array_minimumtimeintervalmonths",
  triggerValue: "array_triggervalue",
  minimumIncreaseAmount: "array_minimumincreaseamountcpi",
  minimumIncreasePercentage: "array_minimumincreasepercentagecpi",
  maximumIncreaseAmount: "array_maximumincreaseamountcpi",
  maximumIncreasePercentage: "array_maximumincreasepercentagecpi",
  lastAdjustmentDate: "array_lastadjustmentdatecpi",
  cpiType: "array_cpitype",
  cpiRentFrequency: "array_cpirentfrequency",
  cpiReferenceMonth: "array_cpireferencemonth",
  cpiCustomMonth: "array_cpicustommonth",
  skipFirstCPISchedule: "array_skipfirstcpischedule",
  chargeTypeCPI: "array_chargetypecpi",
  indexationEnabled: "array_indexationyn",
  minimumIncreaseOnNegativeCPI: "array_minimumincreaseonnegativecpi",
  flatAmountCPI: "array_flatamountcpi",
  enableCustomCPISchedule: "array_enablecustomcpischedule",
  adBoardPermission: "array_adboardpermission",
  fitoutAtLandlordExpense: "array_fitoutattheexpenseofthelandlord",
};

// ---- Create a single lease clause Dataverse record ----
async function createLeaseClauseRecord(leaseId, unitId, clause) {
  console.log(" createLeaseClauseRecord called:", {
    leaseId,
    unitId,
    clauseType: clause.clauseType,
    stepRentEnabled: clause.stepRentEnabled,
    indexationEnabled: clause.indexationEnabled,
    turnoverRentEnabled: clause.turnoverRentEnabled,
  });

  const isValidGuid = (id) =>
    typeof id === "string" &&
    id.trim() !== "" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      id.trim(),
    );

  let payload = {
    "array_LeaseAgreement@odata.bind": `/array_leaseagreements(${leaseId})`,
  };

  // Local bindLookup - only adds annotation when id is a non-empty valid GUID.
  // Guards against the "annotation without value" OData 400 error.
  function bindLookup(navigationProperty, entitySetName, id) {
    if (id && typeof id === "string" && id.trim() !== "" && isValidGuid(id)) {
      payload[`${navigationProperty}@odata.bind`] =
        `/${entitySetName}(${id.trim()})`;
    }
  }

  if (unitId && unitId !== "global" && isValidGuid(unitId)) {
    payload["array_Unit@odata.bind"] = `/array_units(${unitId})`;
  }

  // -- Resolve Clause Name --------------------------------------------------
  let leaseName = "";
  let clauseTypeName = clause.clauseType || "";
  let chargeTypeName = "";

  try {
    const lr = await XrmContext.WebApi.retrieveRecord(
      "array_leaseagreement",
      leaseId,
      "?$select=array_leasename",
    );
    leaseName = lr.array_leasename || "";
  } catch (e) {
    console.warn("  Could not fetch lease name:", e);
  }

  if (clause.clauseType) {
    try {
      const ctr = await XrmContext.WebApi.retrieveMultipleRecords(
        "array_clausetype",
        `?$select=array_clausetypeid,array_clausetypename&$filter=array_clausetypename eq '${clause.clauseType.replace(/'/g, "''")}'`,
      );
      if (ctr.entities.length > 0) {
        clauseTypeName = ctr.entities[0].array_clausetypename;
        payload["array_ClauseType@odata.bind"] =
          `/array_clausetypes(${ctr.entities[0].array_clausetypeid})`;
        console.log(" ClauseType bound:", clauseTypeName);
      } else {
        console.warn(
          `  ClauseType not found in Dataverse for: "${clause.clauseType}"`,
        );
      }
    } catch (e) {
      console.warn("  ClauseType lookup failed:", e);
    }
  }

  const ctField =
    clause.chargeTypeCPI ||
    clause.chargeTypeStepIncrease ||
    clause.chargeTypeTurnover;
  if (ctField && isValidGuid(ctField)) {
    try {
      const ctr = await XrmContext.WebApi.retrieveRecord(
        "array_chargetype",
        ctField,
        "?$select=array_name",
      );
      chargeTypeName = ctr.array_name || "";
    } catch (e) {
      console.warn("  ChargeType name fetch failed:", e);
    }
  }

  let clauseName = "";
  if (leaseName && clauseTypeName) {
    clauseName = chargeTypeName
      ? `${leaseName} - ${clauseTypeName} - ${chargeTypeName}`
      : `${leaseName} - ${clauseTypeName}`;
  } else if (clauseTypeName) {
    clauseName = clauseTypeName;
  }
  if (clauseName) payload["array_leaseclausename"] = clauseName;

  // -- Dates ----------------------------------------------------------------
  if (clause.effectiveDate) {
    const d = convertToISODate(clause.effectiveDate);
    if (d) payload["array_effectivedate"] = d;
  }
  if (clause.expiryDate) {
    const d = convertToISODate(clause.expiryDate);
    if (d) payload["array_expirydate"] = d;
  }

  if (clause.description || clause.clauseSummary) {
    payload["array_description"] =
      clause.description || clause.clauseSummary || "";
  }
  if (clause.clauseSummary) {
    payload["array_clausesummary"] = clause.clauseSummary;
  }

  // ==========================================================================
  // STEP RENT INDEXATION
  // ==========================================================================
  if (clause.stepRentEnabled === true) {
    console.log("&#x1F4CB; Building Step Rent payload fields...");

    payload["array_steprent"] = true;

    bindLookup(
      "array_ChargeTypeStepIncrease",
      "array_chargetypes",
      clause.chargeTypeStepIncrease,
    );

    if (clause.increaseType !== undefined && clause.increaseType !== "") {
      payload["array_increasetype"] = parseInt(clause.increaseType);
    }

    if (clause.flatAmount !== undefined && clause.flatAmount !== "") {
      const fa = parseFloat(clause.flatAmount);
      if (!isNaN(fa)) payload["array_flatamount"] = fa;
    }

    if (
      clause.stepRentPercentage !== undefined &&
      clause.stepRentPercentage !== ""
    ) {
      const srp = parseFloat(clause.stepRentPercentage);
      if (!isNaN(srp)) payload["array_steprentpercentage"] = srp;
    }

    if (
      clause.stepRentFrequency !== undefined &&
      clause.stepRentFrequency !== ""
    ) {
      payload["array_steprentfrequency"] = parseInt(clause.stepRentFrequency);
    }

    payload["array_enablecustomsteprentschedule"] =
      clause.enableCustomStepRentSchedule === true;

    if (clause.enableCustomStepRentSchedule === true) {
      if (clause.stepRentCycleStartDate) {
        const d = convertToISODate(clause.stepRentCycleStartDate);
        if (d) payload["array_steprentcyclestartdate"] = d;
      }
      if (clause.stepRentCycleEndDate) {
        const d = convertToISODate(clause.stepRentCycleEndDate);
        if (d) payload["array_steprentenddate"] = d;
      }
    }

    console.log(" Step Rent payload built:", {
      array_steprent: payload["array_steprent"],
      array_increasetype: payload["array_increasetype"],
      array_steprentfrequency: payload["array_steprentfrequency"],
      array_steprentcyclestartdate: payload["array_steprentcyclestartdate"],
      array_steprentenddate: payload["array_steprentenddate"],
    });
  }

  // ==========================================================================
  // VALUE PROTECTION (CPI)
  // ==========================================================================
  if (clause.indexationEnabled === true) {
    console.log("&#x1F4CB; Building CPI payload fields...");

    payload["array_indexationyn"] = true;

    bindLookup("array_CPIType", "array_cpitypes", clause.cpiType);

    if (clause.currentIndex !== undefined && clause.currentIndex !== "") {
      const ci = parseFloat(clause.currentIndex);
      if (!isNaN(ci)) payload["array_currentindex"] = ci;
    }

    if (
      clause.initialWaitingPeriod !== undefined &&
      clause.initialWaitingPeriod !== ""
    ) {
      const iwp = parseInt(clause.initialWaitingPeriod);
      if (!isNaN(iwp)) payload["array_initialwaitingperiodmonths"] = iwp;
    }

    bindLookup(
      "array_ChargeTypeCPI",
      "array_chargetypes",
      clause.chargeTypeCPI,
    );

    if (clause.increaseTypeCPI !== undefined && clause.increaseTypeCPI !== "") {
      payload["array_increasetypecpirentprocess"] = parseInt(
        clause.increaseTypeCPI,
      );
    }

    if (clause.flatAmountCPI !== undefined && clause.flatAmountCPI !== "") {
      const fa = parseFloat(clause.flatAmountCPI);
      if (!isNaN(fa)) payload["array_flatamountcpi"] = fa;
    }

    // FIX: property name now matches what captureClauseSpecificDataFromForm stores
    if (
      clause.minimumIncreaseFlatAmountCPI !== undefined &&
      clause.minimumIncreaseFlatAmountCPI !== ""
    ) {
      const mifa = parseFloat(clause.minimumIncreaseFlatAmountCPI);
      if (!isNaN(mifa)) payload["array_minimumincreaseflatamountcpi"] = mifa;
    }

    if (
      clause.minimumIncreasePercentage !== undefined &&
      clause.minimumIncreasePercentage !== ""
    ) {
      const mip = parseFloat(clause.minimumIncreasePercentage);
      if (!isNaN(mip)) payload["array_minimumincreasepercentagecpi"] = mip;
    }

    if (
      clause.maximumIncreasePercentage !== undefined &&
      clause.maximumIncreasePercentage !== ""
    ) {
      const mxp = parseFloat(clause.maximumIncreasePercentage);
      if (!isNaN(mxp)) payload["array_maximumincreasepercentagecpi"] = mxp;
    }

    if (
      clause.minimumTimeInterval !== undefined &&
      clause.minimumTimeInterval !== ""
    ) {
      const mti = parseInt(clause.minimumTimeInterval);
      if (!isNaN(mti)) payload["array_minimumtimeintervalmonths"] = mti;
    }

    if (clause.triggerValue !== undefined && clause.triggerValue !== "") {
      const tv = parseFloat(clause.triggerValue);
      if (!isNaN(tv)) payload["array_triggervalue"] = tv;
    }

    if (
      clause.cpiRentFrequency !== undefined &&
      clause.cpiRentFrequency !== ""
    ) {
      payload["array_cpirentfrequency"] = parseInt(clause.cpiRentFrequency);
    }

    // CPI Reference Month (+ Custom Month only when Reference Month = Custom Month)
    if (
      clause.cpiReferenceMonth !== undefined &&
      clause.cpiReferenceMonth !== ""
    ) {
      const rm = parseInt(clause.cpiReferenceMonth, 10);
      if (!isNaN(rm)) {
        payload["array_cpireferencemonth"] = rm;
        if (
          rm === CPI_REF.CUSTOM &&
          clause.cpiCustomMonth !== undefined &&
          clause.cpiCustomMonth !== ""
        ) {
          const cm = parseInt(clause.cpiCustomMonth, 10);
          if (!isNaN(cm)) payload["array_cpicustommonth"] = cm;
        }
      }
    }

    // Skip First CPI Schedule - defaults to No, same as the Lease Clause form
    payload["array_skipfirstcpischedule"] =
      clause.skipFirstCPISchedule === true;

    payload["array_enablecustomcpischedule"] =
      clause.enableCustomCPISchedule === true;

    if (clause.enableCustomCPISchedule === true) {
      if (clause.cpiScheduleStartDate) {
        const d = convertToISODate(clause.cpiScheduleStartDate);
        if (d) payload["array_cpicyclestartdate"] = d;
      }
      if (clause.cpiScheduleEndDate) {
        const d = convertToISODate(clause.cpiScheduleEndDate);
        if (d) payload["array_cpischeduleenddate"] = d;
      }
    }

    console.log(" CPI payload built:", {
      array_indexationyn: payload["array_indexationyn"],
      array_currentindex: payload["array_currentindex"],
      array_cpirentfrequency: payload["array_cpirentfrequency"],
      array_cpireferencemonth: payload["array_cpireferencemonth"],
      array_cpicustommonth: payload["array_cpicustommonth"],
      array_skipfirstcpischedule: payload["array_skipfirstcpischedule"],
      array_triggervalue: payload["array_triggervalue"],
      array_minimumincreaseflatamountcpi:
        payload["array_minimumincreaseflatamountcpi"],
    });
  }

  // ==========================================================================
  // TURNOVER RENT
  // ==========================================================================
  if (clause.turnoverRentEnabled === true) {
    console.log("&#x1F4CB; Building Turnover Rent payload...");

    payload["array_turnoverrent"] = true;

    if (clause.subjectToVAT !== undefined) {
      payload["array_subjecttovat"] = clause.subjectToVAT === true;
    }

    if (clause.subjectToVAT === true) {
      bindLookup("array_VAT", "array_vats", clause.vat);
    }

    if (clause.taxIncluded !== undefined) {
      payload["array_taxincluded"] = clause.taxIncluded === true;
    }

    if (clause.enableOCR !== undefined) {
      payload["array_enableocr"] = clause.enableOCR === true;
    }

    if (clause.enableProration !== undefined) {
      payload["array_enableprorationturnoverrent"] =
        clause.enableProration === true;
    }

    if (
      clause.turnoverRentBasis !== undefined &&
      clause.turnoverRentBasis !== ""
    ) {
      const v = parseInt(clause.turnoverRentBasis);
      if (!isNaN(v)) payload["array_turnoverrentbasis"] = v;
    }

    bindLookup(
      "transactioncurrencyid",
      "transactioncurrencies",
      clause.currency,
    );

    if (clause.salesThreshold !== undefined && clause.salesThreshold !== "") {
      const v = parseFloat(clause.salesThreshold);
      if (!isNaN(v)) payload["array_salesthreshold"] = v;
    }

    bindLookup(
      "array_ChargeTypeTurnoverRent",
      "array_chargetypes",
      clause.chargeTypeTurnover,
    );

    // -- Secondary Charge Type ------------------------------------------------
    // Navigation property MUST use PascalCase to match Dataverse OData metadata.
    // The lookup field is _array_secondarychargetypeforadvanceturnoverrent_value
    // so the navigation property name is array_SecondaryChargeTypeForAdvanceTurnoverRent
    if (
      clause.enableOCR === true &&
      clause.secondaryChargeTypeTurnover &&
      typeof clause.secondaryChargeTypeTurnover === "string" &&
      clause.secondaryChargeTypeTurnover.trim() !== "" &&
      isValidGuid(clause.secondaryChargeTypeTurnover.trim())
    ) {
      payload["array_SecondaryChargeTypeforAdvanceTurnoverRent@odata.bind"] =
        `/array_chargetypes(${clause.secondaryChargeTypeTurnover.trim()})`;
      console.log(
        " Secondary charge type bound:",
        clause.secondaryChargeTypeTurnover.trim(),
      );
    } else {
      console.log(
        "i Secondary charge type skipped - OCR:",
        clause.enableOCR,
        "| value:",
        clause.secondaryChargeTypeTurnover ?? "(none)",
      );
    }

    if (clause.settlementCycle !== undefined && clause.settlementCycle !== "") {
      const v = parseInt(clause.settlementCycle);
      if (!isNaN(v)) payload["array_settlementcycle"] = v;
    }

    payload["array_enablecustomturnoverschedule"] =
      clause.enableCustomTurnoverSchedule === true;

    if (clause.enableCustomTurnoverSchedule === true) {
      if (clause.turnoverCycleStartDate) {
        const d = convertToISODate(clause.turnoverCycleStartDate);
        if (d) payload["array_turnovercyclestartdate"] = d;
      }

      if (clause.turnoverCycleEndDate) {
        let endDateStr = clause.turnoverCycleEndDate;

        if (clause.expiryDate) {
          const endDate = new Date(clause.turnoverCycleEndDate);
          const expiryDate = new Date(clause.expiryDate);
          endDate.setHours(0, 0, 0, 0);
          expiryDate.setHours(0, 0, 0, 0);
          if (!isNaN(endDate.getTime()) && !isNaN(expiryDate.getTime())) {
            if (endDate > expiryDate) {
              endDateStr = clause.expiryDate;
              console.log(
                `  Turnover cycle end date (${clause.turnoverCycleEndDate}) exceeds expiry - capped to expiry date`,
              );
            }
          }
        }

        const d = convertToISODate(endDateStr);
        if (d) payload["array_turnovercycleenddate"] = d;
      }
    }

    if (clause.reportingCycle !== undefined && clause.reportingCycle !== "") {
      const v = parseInt(clause.reportingCycle);
      if (!isNaN(v)) payload["array_reportingcycle"] = v;
    }

    if (
      clause.turnoverRentCalculationType !== undefined &&
      clause.turnoverRentCalculationType !== ""
    ) {
      const v = parseInt(clause.turnoverRentCalculationType);
      if (!isNaN(v)) payload["array_turnoverrentcalculationtype"] = v;
    }

    if (
      clause.increaseTypeTurnover !== undefined &&
      clause.increaseTypeTurnover !== ""
    ) {
      const v = parseInt(clause.increaseTypeTurnover);
      if (!isNaN(v)) payload["array_increasetypeturnoverrent"] = v;
    }

    if (
      clause.flatAmountTurnoverRent !== undefined &&
      clause.flatAmountTurnoverRent !== ""
    ) {
      const v = parseFloat(clause.flatAmountTurnoverRent);
      if (!isNaN(v)) payload["array_flatamountturnoverrent"] = v;
    }

    if (
      clause.minSalesRentAmount !== undefined &&
      clause.minSalesRentAmount !== ""
    ) {
      const v = parseFloat(clause.minSalesRentAmount);
      if (!isNaN(v)) payload["array_minimumsalesbasedrentamount"] = v;
    }

    if (clause.turnoverRate !== undefined && clause.turnoverRate !== "") {
      const v = parseFloat(clause.turnoverRate);
      if (!isNaN(v)) payload["array_turnoverrate"] = v;
    }

    if (
      clause.minimumTurnoverPercentage !== undefined &&
      clause.minimumTurnoverPercentage !== ""
    ) {
      const v = parseFloat(clause.minimumTurnoverPercentage);
      if (!isNaN(v)) payload["array_minimumturnoverpercentage"] = v;
    }

    console.log(" Turnover Rent payload ready:", {
      array_turnoverrent: payload["array_turnoverrent"],
      array_turnoverrentbasis: payload["array_turnoverrentbasis"],
      array_settlementcycle: payload["array_settlementcycle"],
      array_enableocr: payload["array_enableocr"],
      array_turnovercyclestartdate: payload["array_turnovercyclestartdate"],
      array_turnovercycleenddate: payload["array_turnovercycleenddate"],
    });
  }

  // -- Pre-flight sanitizer -------------------------------------------------
  // Remove any @odata.bind annotation whose value is falsy or empty.
  Object.keys(payload).forEach((key) => {
    if (key.endsWith("@odata.bind")) {
      const val = payload[key];
      if (!val || typeof val !== "string" || val.trim() === "") {
        console.warn(
          `  Removing invalid @odata.bind annotation: ${key} =`,
          val,
        );
        delete payload[key];
      }
    }
  });

  console.log(" Final clause payload:", JSON.parse(JSON.stringify(payload)));

  const result = await XrmContext.WebApi.createRecord(
    "array_leaseclause",
    payload,
  );
  console.log(` Clause record created:`, result.id);
  return result;
}

//---------------------------------------- UPLOAD & AUTOFILL FEATURE -----------------------------------//
// Flow trigger URLs are stored as Dataverse environment variables so they can
// differ per environment (dev/test/prod) without a code change. Resolved at
// call time via getEnvVarValue().
// Main agent flow - extracts every stage EXCEPT discounts, options and financial
// clauses, and returns boolean flags (hasFinancialClauses / hasLeaseOptions /
// hasDiscount) indicating whether a second pass is needed.
const AUTOFILL_FLOW_ENV_VAR = "array_LeaseDraftMainAgent";

// Sub-agent flow - extracts discounts, lease options and financial clauses.
// Called in the background ONLY when the main agent flags one of those sections.
const AUTOFILL_SUBAGENT_FLOW_ENV_VAR = "array_LeaseDraftSubAgent";

// Stages whose data comes from the sub-agent flow: 4 Discounts, 6 Options, 7 Clauses.
// (Stage 5 is Security & Insurance - NOT a sub-agent stage.)
const _SUBAGENT_STAGES = [4, 6, 7];
// "idle" | "running" | "done" | "error" - drives the stage-aware loader.
window._subAgentFlowState = "idle";

// -----------------------------------------------------------------------------
// FUZZY MATCHING & DATAVERSE RESOLVER ALGORITHM
// -----------------------------------------------------------------------------

// 1. Levenshtein Distance Calculator (Returns % match 0-100)
function calculateSimilarity(str1, str2) {
  // \p{L} keeps ALL letters from any language, \p{N} keeps numbers.
  const s1 = str1.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const s2 = str2.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

  if (s1 === s2) return 100;
  if (s1.length === 0 || s2.length === 0) return 0;

  const matrix = [];
  for (let i = 0; i <= s2.length; i++) matrix[i] = [i];
  for (let j = 0; j <= s1.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= s2.length; i++) {
    for (let j = 1; j <= s1.length; j++) {
      if (s2.charAt(i - 1) === s1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1), // insertion/deletion
        );
      }
    }
  }
  const distance = matrix[s2.length][s1.length];
  const maxLength = Math.max(s1.length, s2.length);
  return ((maxLength - distance) / maxLength) * 100;
}

// Strips generic legal-entity descriptors from an already-normalized company name
// (lowercased, diacritics removed) so the distinctive core/brand can be compared.
// Covers common abbreviations and full forms across multiple jurisdictions - not
// specific to any one company or language.
function stripCompanyForms(s) {
  return (
    String(s || "")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      // Multi-word legal forms (spelled out).
      .replace(/\bspolka z ograniczona odpowiedzialnoscia\b/g, " ")
      .replace(/\bspolka akcyjna\b/g, " ")
      .replace(/\bsp\s+z\s+o\s+o\b/g, " ")
      .replace(/\bz\s+o\s+o\b/g, " ")
      .replace(/\bsociete a responsabilite limitee\b/g, " ")
      .replace(/\bgesellschaft mit beschrankter haftung\b/g, " ")
      // Single-token legal forms / abbreviations across jurisdictions.
      .replace(
        /\b(spzoo|spolka|spolki|spolke|sp|sa|ska|oo|ooo|zoo|zao|oao|pao|ltd|limited|llc|lp|llp|plc|pllc|inc|incorporated|corp|corporation|company|co|gmbh|mbh|ag|kg|ohg|kgaa|ug|bv|nv|oy|oyj|ab|asa|as|sas|sarl|sl|slu|spa|srl|srls|sro|sas|kft|doo|doel|pte|pty|kk|gk)\b/g,
        " ",
      )
      .replace(/\s+/g, " ")
      .trim()
  );
}

// 2. Dataverse Lookup Auto-Resolver
async function resolveDataverseLookup(aiText, lookupType) {
  if (!aiText) return null;

  let entityLogicalName = "";
  let selectFields = "";
  let nameField = "";

  // Determine query based on lookup type (MUST use singular logical names for Xrm.WebApi)
  if (lookupType === "Tenant") {
    entityLogicalName = "account";
    selectFields = "accountid,name";
    nameField = "name";
  } else if (lookupType === "Property") {
    entityLogicalName = "array_property"; // Changed from plural 'array_properties'
    // Double check your exact schema name for the property name column (e.g., array_name or array_propertyname)
    selectFields = "array_propertyid,array_propertyrecordid,array_propertyname";
    nameField = "array_propertyname";
  } else {
    return null;
  }

  try {
    // Fetch ALL active records (safe for hundreds of records)
    const query = `?$select=${selectFields}&$filter=statecode eq 0`;
    const result = await XrmContext.WebApi.retrieveMultipleRecords(
      entityLogicalName,
      query,
    );

    let bestMatch = null;
    let highestScore = 0;

    // --- POLISH GRAMMAR & TEXT NORMALIZATION ---
    const normalizeText = (t) => {
      if (!t) return "";
      let n = t
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\u0142/g, "l");
      n = n
        .replace(/s\.a\./g, "spolka akcyjna")
        .replace(/\bsa\b/g, "spolka akcyjna");
      return n;
    };

    // Extracts meaningful tokens (length > 2, strips punctuation)
    const extractTokens = (text) =>
      text
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2);

    const aiTextNormalized = normalizeText(aiText);
    const aiTokens = extractTokens(aiTextNormalized);
    const cityRoots = ["lodz", "torun", "krakow", "karkow"];

    // Evaluate each record
    for (let record of result.entities) {
      if (lookupType === "Property") {
        console.log("DATAVERSE PROPERTY RECORD ->", record);
      }

      const recordName = record[nameField];
      if (!recordName) continue;

      const recordNameNormalized = normalizeText(recordName);

      let score;

      if (lookupType === "Property") {
        // The agent now returns the property name EXACTLY as stored in the
        // system. Prefer an exact (case/whitespace-insensitive) match - it
        // resolves the correct centre even when several share distinctive
        // tokens, and short-circuits the fuzzy fallback below.
        const _exactRaw =
          recordName.trim().toLowerCase() === aiText.trim().toLowerCase();
        const _exactNorm = recordNameNormalized === aiTextNormalized;
        if (_exactRaw || _exactNorm) {
          bestMatch = {
            id: record[`${entityLogicalName}id`],
            name: recordName,
            logicalName: entityLogicalName,
            score: 100,
          };
          highestScore = 100;
          break;
        }

        // Strip address suffix from AI text: after comma, ul./al. patterns, "w <City>", stray numbers
        const aiCore = aiTextNormalized
          .split(",")[0]
          .replace(/\b(ul|al|os|pl)\.?\s+\S+(\s+[\d\/\-\w]+)?/gi, "")
          .replace(/\bw\s+\S+/gi, "")
          .replace(/\b\d[\d\/\-]*\b/g, "")
          .replace(/\s+/g, " ")
          .trim();

        // Expand "ch" abbreviation and clean dashes in record name
        // (en/em dashes written as \u escapes so a wrong-encoding
        // re-save cannot corrupt this character class and break the regex)
        const recExpanded = recordNameNormalized
          .replace(/[-\u2013\u2014]/g, " ")
          .replace(/\bch\b/g, "centrum handlowe")
          .replace(/\s+/g, " ")
          .trim();

        // Generic mall/address words appear in nearly every property name
        // (e.g. "Centrum Handlowe ..."), so matching on them resolves to the
        // wrong centre. Drop them and key on the DISTINCTIVE name tokens
        // (e.g. "czyzyny", "guliwer", "bielawy"). City roots are also generic
        // here since the AI core has its "w <city>" suffix already stripped.
        const PROP_STOPWORDS = new Set([
          "centrum",
          "handlowe",
          "centra",
          "galeria",
          "galerie",
          "park",
          "retail",
          "shopping",
          "centre",
          "center",
          "the",
          ...cityRoots,
        ]);
        const distinctive = (text) =>
          extractTokens(text).filter((t) => !PROP_STOPWORDS.has(t));

        const aiCoreTokens = distinctive(aiCore);
        const recTokens = distinctive(recExpanded);
        // No distinctive token on either side \u2192 can't safely match; skip so
        // the user resolves it manually instead of getting a wrong default.
        if (aiCoreTokens.length === 0) continue;

        const propMatchedTokens = aiCoreTokens.filter((t) =>
          recTokens.includes(t),
        );
        // Require at least one DISTINCTIVE token in common.
        if (propMatchedTokens.length < 1) continue;

        // Score by how many of the AI's distinctive tokens the record covers,
        // backstopped by raw string similarity of the distinctive cores.
        const overlap = propMatchedTokens.length / aiCoreTokens.length;
        score = Math.max(
          overlap * 100,
          calculateSimilarity(aiCoreTokens.join(" "), recTokens.join(" ")),
        );
      } else if (lookupType === "Tenant") {
        // Company names commonly differ only by their legal-entity form: a document
        // may carry a short/abbreviated form while the record holds the full legal
        // name (or vice versa), in any of several jurisdictions. Strip these generic
        // descriptors from BOTH sides and compare the distinctive core (brand) name.
        const aiCore = stripCompanyForms(aiTextNormalized);
        const recCore = stripCompanyForms(recordNameNormalized);
        const aiCoreTokens = aiCore.split(/\s+/).filter((w) => w.length > 1);
        if (aiCoreTokens.length === 0) continue;

        const matchedCore = aiCoreTokens.filter((t) => recCore.includes(t));
        const coreSim = calculateSimilarity(aiCore, recCore);

        // Accept when every core token is present, when >= 2 match, or when the
        // cores are highly similar - otherwise this candidate is not a tenant match.
        const enough =
          matchedCore.length >= 2 ||
          matchedCore.length === aiCoreTokens.length ||
          coreSim >= 85;
        if (!enough) continue;

        score = Math.max(
          calculateSimilarity(aiTextNormalized, recordNameNormalized),
          coreSim,
        );
      } else {
        score = calculateSimilarity(aiTextNormalized, recordNameNormalized);
      }

      if (score > highestScore) {
        highestScore = score;
        bestMatch = {
          id: record[`${entityLogicalName}id`],
          name: recordName,
          logicalName: entityLogicalName,
          score: highestScore,
        };
      }
    }

    // Confidence thresholds per lookup type
    const requiredScore =
      lookupType === "Tenant" ? 70 : lookupType === "Property" ? 55 : 50;

    if (highestScore >= requiredScore) {
      console.log(
        `Auto-resolved ${lookupType}: "${bestMatch.name}" (${highestScore.toFixed(1)}% match)`,
      );
      return bestMatch;
    } else {
      console.warn(
        `Match too low for ${lookupType} (${highestScore.toFixed(1)}%). Highest was "${bestMatch ? bestMatch.name : "none"}". Waiting for user input.`,
      );
      return null;
    }
  } catch (error) {
    console.error(`Failed to resolve ${lookupType} in Dataverse:`, error);
    return null;
  }
}

// -----------------------------------------------------------------------------
// LEASE DEFAULTS - shared completeness check, lease-date re-sync
// -----------------------------------------------------------------------------

// Mirrors the required-field validation in saveRecurringCharge so the grid tag
// matches what the modal enforces. Exchange rate rule only for non-PLN.
function _chargeNeedsCompletion(c) {
  const rateRuleRequired = !!c.currencyCode && c.currencyCode !== "PLN";
  return (
    !c.name ||
    !c.chargeType ||
    !(c.amount > 0) ||
    !c.currency ||
    !c.startDate ||
    (!c.isShortTerm && !c.endDate) ||
    !c.frequency ||
    !c.invoiceGenerationDate ||
    !c.dueDateRule ||
    !c.vat ||
    !c.bankAccount ||
    !c.invoiceType ||
    !c.invoicePrefix ||
    (rateRuleRequired && !c.rateRule)
  );
}

// Re-apply lease start/end to fields that still hold a DEFAULTED value (or are
// empty) after the user changes the lease dates. Document values and user edits
// are never touched.
function _syncDefaultsFromLeaseDates() {
  const ls = document.getElementById("startDate")?.value || "";
  const le = document.getElementById("endDate")?.value || "";
  let chargesChanged = false;

  (recurringCharges || []).forEach((c) => {
    if (c.isExisting || !c._defaulted) return;
    const oneTime = /one\s*time/i.test(c.frequencyName || "");
    let ch = false;
    if (ls && (c._defaulted.startDate || !c.startDate)) {
      c.startDate = ls;
      c._defaulted.startDate = true;
      ch = true;
    }
    if (oneTime) {
      if (c.startDate && (c._defaulted.endDate || !c.endDate)) {
        c.endDate = c.startDate;
        c._defaulted.endDate = true;
        ch = true;
      }
    } else if (!c.isShortTerm && le && (c._defaulted.endDate || !c.endDate)) {
      c.endDate = le;
      c._defaulted.endDate = true;
      ch = true;
    }
    // Only re-evaluate charges touched here (modal-saved charges keep the
    // modal's own completeness result).
    if (ch) {
      c.needsCompletion = _chargeNeedsCompletion(c);
      chargesChanged = true;
    }
  });
  if (chargesChanged && typeof renderAllChargesGrid === "function")
    renderAllChargesGrid();

  if (ls && Array.isArray(deposits)) {
    let depChanged = false;
    deposits.forEach((d) => {
      if (!d || !d._defaulted) return;
      if (d._defaulted.startDate) d.startDate = ls;
      if (d._defaulted.dueDate) d.dueDate = ls;
      depChanged = depChanged || d._defaulted.startDate || d._defaulted.dueDate;
    });
    if (depChanged && typeof renderDeposits === "function") renderDeposits();
  }

  // Lease options (Stage 6)
  let optChanged = false;
  (window.sessionLeaseOptions || []).forEach((o) => {
    if (!o || !o._defaulted) return;
    let ch = false;
    if (o._defaulted.executionDate && ls) {
      o.executionDate = ls;
      ch = true;
    }
    if (o._defaulted.expirationDate && le) {
      o.expirationDate = le;
      ch = true;
    }
    if (ch) optChanged = true;
    const nd = parseInt(o.noticePeriod, 10);
    if (ch && o.expirationDate && !isNaN(nd) && nd >= 0) {
      const d = new Date(o.expirationDate);
      d.setDate(d.getDate() - nd);
      o.noticeDate = _afDateInput(d);
    }
  });
  if (optChanged && typeof renderOptionsGrid === "function")
    renderOptionsGrid();

  // Financial clauses (Stage 7) - CPI / turnover / step rent / others
  _resyncClauseDates();
}

// yyyy-mm-dd + N months (month-end safe), optionally minus one day.
function _addMonthsIso(iso, months, minusOneDay) {
  const p = String(iso || "").split("-").map(Number);
  if (p.length !== 3 || p.some(isNaN)) return "";
  const d = new Date(p[0], p[1] - 1 + months, p[2]);
  if (d.getDate() !== p[2]) d.setDate(0); // e.g. 31 Jan + 1 month -> 28/29 Feb
  if (minusOneDay) d.setDate(d.getDate() - 1);
  return _afDateInput(d);
}

// Default every clause Effective / Expiry date that the user has not edited:
//   - lease-relative offset set (data-lease-offset-months):
//       effective = lease start + N months; expiry = lease start + N months - 1 day
//   - otherwise effective = lease start, expiry = lease end
// Dates from the document or typed by the user carry data-user-modified and
// are never touched.
function _resyncClauseDates() {
  const container = document.getElementById("clausesContainer");
  if (!container) return;
  const ls = document.getElementById("startDate")?.value || "";
  const le = document.getElementById("endDate")?.value || "";
  container
    .querySelectorAll(".clause-effective-date, .clause-expiry-date")
    .forEach((el) => {
      if (ls) el.min = ls;
      if (el.getAttribute("data-user-modified")) return;
      const isEff = el.classList.contains("clause-effective-date");
      const off = el.dataset.leaseOffsetMonths;
      if (off !== undefined && off !== "") {
        el.value = ls ? _addMonthsIso(ls, parseInt(off, 10), !isEff) : "";
      } else {
        el.value = isEff ? ls : le;
      }
    });
}

// A date the user picks on a clause is theirs: stop defaulting it.
document.addEventListener("change", function (e) {
  const t = e.target;
  if (
    e.isTrusted &&
    t &&
    t.classList &&
    (t.classList.contains("clause-effective-date") ||
      t.classList.contains("clause-expiry-date"))
  ) {
    t.setAttribute("data-user-modified", "true");
    delete t.dataset.leaseOffsetMonths;
  }
});

document.addEventListener("change", function (e) {
  const id = e.target && e.target.id;
  if (id === "startDate" || id === "endDate") _syncDefaultsFromLeaseDates();
});

// -----------------------------------------------------------------------------
// AUTOFILL HELPERS (shared by unit / option / clause autofill)
// -----------------------------------------------------------------------------

// Normalize for loose comparison: collapse whitespace, trim, lowercase.
function _afNorm(s) {
  return String(s == null ? "" : s)
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Read a {value, confidence} wrapper (or a raw value) -> trimmed string ("" when null).
function _afVal(obj) {
  if (obj == null) return "";
  const v = obj && typeof obj === "object" && "value" in obj ? obj.value : obj;
  return v == null ? "" : String(v).trim();
}

// Read a boolean from a {value} wrapper or raw value.
function _afBool(obj) {
  const v = obj && typeof obj === "object" && "value" in obj ? obj.value : obj;
  return v === true || v === "true";
}

// Convert any date-ish string to yyyy-mm-dd ("" when invalid/empty).
function _afDateInput(s) {
  if (!s) return "";
  const d = s instanceof Date ? s : new Date(s);
  if (isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function _afSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Set a <select> by matching its option text to a label (exact -> contains, both ways).
// Returns true when a match was applied.
function _afSetSelectByText(selectEl, text, options = {}) {
  const { fireChange = false } = options;
  if (!selectEl || text == null || text === "") return false;
  const target = _afNorm(text);
  if (!target) return false;
  const opts = Array.from(selectEl.options);
  const match =
    opts.find((o) => _afNorm(o.textContent) === target) ||
    opts.find(
      (o) =>
        _afNorm(o.textContent).length > 1 &&
        _afNorm(o.textContent).includes(target),
    ) ||
    opts.find(
      (o) =>
        _afNorm(o.textContent).length > 1 &&
        target.includes(_afNorm(o.textContent)),
    );
  if (!match) return false;
  selectEl.value = match.value;
  if (fireChange)
    selectEl.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

// Set a charge-type <select> from an AI value ("RHAN", "AR - <description>").
// Resolves by code via resolveChargeType() and selects by record ID, avoiding the
// fuzzy text match in _afSetSelectByText (which mapped e.g. "KO - Service charge..."
// to "AR" because "charge" contains "ar").
// Agent 2 (clauses) decides charge codes without seeing Agent 1's output and can
// drift (e.g. RHAN for a short-term stand Agent 1 coded CZE). If Agent 2's code is
// not among Agent 1's charge codes, substitute Agent 1's code of the same family
// (rent -> rent, service charge -> service charge). Otherwise keep it unchanged.
const _AF_RENT_CODES = ["RHAN", "CZ", "CZAR", "CZH", "CZE", "CZI", "CZO", "CZX", "CZZ", "CZB", "RENT", "RMAG"];
const _AF_SERVICE_CODES = ["KO", "KOI", "KOZ"];
function _alignAgent2ChargeCode(text) {
  const a1 = window._agent1ChargeCodes || [];
  if (!text || !a1.length) return text;
  const codeOf = (t) => String(t).split(" - ")[0].trim().toUpperCase();
  const code = codeOf(text);
  const a1Codes = a1.map(codeOf);
  if (a1Codes.includes(code)) return text;
  const family = _AF_RENT_CODES.includes(code)
    ? _AF_RENT_CODES
    : _AF_SERVICE_CODES.includes(code)
      ? _AF_SERVICE_CODES
      : null;
  if (!family) return text;
  const idx = a1Codes.findIndex((c) => family.includes(c));
  if (idx === -1) return text;
  console.warn(
    `Clause charge type "${text}" not in Agent 1 charges - aligned to "${a1[idx]}".`,
  );
  return a1[idx];
}

function _afSetChargeTypeSelect(selectEl, text) {
  if (!selectEl || !text) return false;
  text = _alignAgent2ChargeCode(text);
  const types =
    (window.chargeTypes && window.chargeTypes.length && window.chargeTypes) ||
    (chargeTypesLookup && chargeTypesLookup.records) ||
    [];
  const ct = resolveChargeType(types, text);
  if (!ct) return false;
  const opt = Array.from(selectEl.options).find(
    (o) => o.value === ct.array_chargetypeid,
  );
  if (!opt) return false;
  selectEl.value = opt.value;
  return true;
}

// Match a Dataverse global-choice array (optionTypes / optionHolderTypes) entry by label.
function _afMatchChoice(arr, text) {
  if (!Array.isArray(arr) || text == null) return null;
  const target = _afNorm(text);
  if (!target) return null;
  const labelOf = (it) =>
    it?.Label?.UserLocalizedLabel?.Label ||
    it?.Label?.LocalizedLabels?.[0]?.Label ||
    "";
  return (
    arr.find((it) => _afNorm(labelOf(it)) === target) ||
    arr.find(
      (it) =>
        _afNorm(labelOf(it)).length > 1 &&
        _afNorm(labelOf(it)).includes(target),
    ) ||
    arr.find(
      (it) =>
        _afNorm(labelOf(it)).length > 1 &&
        target.includes(_afNorm(labelOf(it))),
    ) ||
    null
  );
}

function _afChoiceLabel(it) {
  return (
    it?.Label?.UserLocalizedLabel?.Label ||
    it?.Label?.LocalizedLabels?.[0]?.Label ||
    ""
  );
}

// -----------------------------------------------------------------------------
// UNIT AUTO-SELECT (single or multi-unit)
// -----------------------------------------------------------------------------
// Resolves one or more units by identifier (matched against array_suitid,
// array_unitname, or array_unitrecordid) and adds them to the Stage 2 selection,
// mirroring confirmUnitSelection's UI updates. Charges are intentionally NOT
// auto-populated here so the document-extracted charges (_pendingChargesAutofill)
// remain the source of truth at Stage 3.
function _mapUnitEntityToUnitData(unit, fallbackName) {
  return {
    id: unit.array_unitid,
    name:
      unit.array_unitname || unit.array_unitrecordid || fallbackName || "Unit",
    recordId: unit.array_unitrecordid || "N/A",
    type:
      unit["_array_unittype_value@OData.Community.Display.V1.FormattedValue"] ||
      "N/A",
    subtype:
      unit[
        "_array_unitsubtypelayout_value@OData.Community.Display.V1.FormattedValue"
      ] || "",
    area: unit.array_unitareasqm || 0,
    floor: unit.array_Floor?.array_floorname || "N/A",
    building:
      unit.array_Building?.array_buildingname ||
      unit["_array_building_value@OData.Community.Display.V1.FormattedValue"] ||
      "N/A",
    buildingId: unit._array_building_value || "",
    property:
      unit["_array_property_value@OData.Community.Display.V1.FormattedValue"] ||
      "",
    bedrooms: unit.array_bedrooms || 0,
    bathrooms: unit.array_bathrooms || 0,
    totalRooms: unit.array_totalrooms || 0,
    coldRent: unit.array_coldrent || 0,
    warmRent: unit.array_warmrent || 0,
    marketRent: unit.array_marketrent || 0,
    securityDeposit: unit.array_securitydeposit || 0,
    location: unit.array_location || "",
    previousRent: null,
  };
}

async function resolveAndSelectUnitsByIdentifier(identifiers) {
  const ids = (Array.isArray(identifiers) ? identifiers : [identifiers])
    .map((v) => String(v || "").trim())
    .filter(Boolean);
  if (!ids.length) return;

  const unitDisplay = document.getElementById("unitDisplay");
  if (unitDisplay) unitDisplay.style.backgroundColor = "#fef08a"; // processing

  try {
    const propertyId = document.getElementById("propertyId")?.value || "";

    // Build an OR group per identifier matching any of the three identifier columns.
    const groups = ids.map((id) => {
      const e = id.replace(/'/g, "''");
      return `(array_suitid eq '${e}' or array_unitname eq '${e}' or array_unitrecordid eq '${e}')`;
    });
    let filter = `statecode eq 0 and (${groups.join(" or ")})`;
    if (propertyId) filter += ` and _array_property_value eq ${propertyId}`;

    const url =
      `?$select=array_unitid,array_unitname,array_unitrecordid,array_unitareasqm,` +
      `array_bedrooms,array_bathrooms,array_totalrooms,array_coldrent,array_warmrent,` +
      `array_marketrent,array_securitydeposit,array_location,array_suitid,` +
      `_array_floor_value,_array_unittype_value,_array_unitsubtypelayout_value,` +
      `_array_building_value,_array_property_value` +
      `&$expand=array_Floor($select=array_floorname),array_Building($select=array_buildingname)` +
      `&$filter=${filter}`;

    const result = await XrmContext.WebApi.retrieveMultipleRecords(
      "array_unit",
      url,
    );

    // Which document identifiers matched nothing?
    const _matched = new Set();
    result.entities.forEach((u) =>
      [u.array_suitid, u.array_unitname, u.array_unitrecordid].forEach(
        (v) => v && _matched.add(String(v).trim().toLowerCase()),
      ),
    );
    const _missing = ids.filter((id) => !_matched.has(id.toLowerCase()));
    _showUnitNotFoundHint(_missing);
    if (_missing.length) {
      showNotification(
        `Unit ${_missing.join(", ")} from the document was not found in the system - please select the unit manually.`,
        "warning",
      );
    }

    if (!result.entities.length) {
      console.warn(`No active units found for identifiers: ${ids.join(", ")}.`);
      _syncUnitDisplay();
      if (unitDisplay) {
        unitDisplay.style.backgroundColor = "#fecdd3"; // not found
        setTimeout(() => {
          unitDisplay.style.transition = "background-color 0.5s ease";
          unitDisplay.style.backgroundColor = "";
        }, 3000);
      }
      return;
    }

    let addedCount = 0;
    result.entities.forEach((unit) => {
      const unitData = _mapUnitEntityToUnitData(unit);
      if (!units.find((u) => u.id === unitData.id)) {
        units.push(unitData);
        addedCount++;
      }
    });
    tempSelectedUnits = [...units];

    updateTotalUnitsArea();
    renderUnits(); // refreshes the Stage 2 selected-units list

    if (unitDisplay) {
      unitDisplay.value = `${units.length} unit${units.length !== 1 ? "s" : ""} selected`;
      unitDisplay.setAttribute("data-user-input", "true");
      updateFieldState(unitDisplay);
      unitDisplay.style.backgroundColor = "#bbf7d0"; // resolved
      setTimeout(() => {
        unitDisplay.style.transition = "background-color 0.5s ease";
        unitDisplay.style.backgroundColor = "";
      }, 3000);
    }

    const foundNames = result.entities
      .map((u) => u.array_unitname || u.array_suitid)
      .join(", ");
    console.log(
      `Auto-selected ${addedCount} unit(s) from ${ids.length} identifier(s): ${foundNames}`,
    );
    if (result.entities.length < ids.length) {
      console.warn(
        `Only ${result.entities.length} of ${ids.length} units matched. Requested: ${ids.join(", ")}`,
      );
    }
  } catch (err) {
    console.error(
      `Failed to resolve units for identifiers "${ids.join(", ")}":`,
      err,
    );
    if (unitDisplay) unitDisplay.style.backgroundColor = "";
  }
}

// Backward-compatible single-unit wrapper.
// Clears the today-default Start/End Date when the AI explicitly returned null
// (start not stated in the document), highlights the field and shows the
// AI's leaseStartDateHint under it. Stage 2 validation already requires a
// start date, so the user must enter the real one before continuing.
function _applyUndeterminedStartDate(flowData) {
  const startEl = document.getElementById("startDate");
  if (!startEl || !flowData) return;

  // Remove any hint left from a previous autofill run
  const oldHint = document.getElementById("startDateAiHint");
  if (oldHint) oldHint.remove();
  startEl.style.backgroundColor = "";

  const _val = (k) =>
    flowData[k] && flowData[k].value != null
      ? String(flowData[k].value).trim()
      : "";
  // Only act when the AI returned the field and it is empty - a response
  // without the key (older flows) leaves the form untouched.
  if (!("leaseStartDate" in flowData) || _val("leaseStartDate")) return;

  startEl.value = "";
  startEl.removeAttribute("data-user-input");
  const endEl = document.getElementById("endDate");
  if (endEl && "leaseEndDate" in flowData && !_val("leaseEndDate")) {
    endEl.value = "";
    endEl.removeAttribute("data-user-input");
  }
  startEl.dispatchEvent(new Event("change", { bubbles: true }));
  if (typeof updateFieldState === "function") updateFieldState(startEl);

  // Amber highlight until the user enters a date
  startEl.style.transition = "background-color 0.3s ease";
  startEl.style.backgroundColor = "#FEF6E0";
  startEl.style.borderColor = "#E3B341";
  const _clearAmber = () => {
    if (startEl.value) {
      startEl.style.backgroundColor = "";
      startEl.style.borderColor = "";
      startEl.removeEventListener("change", _clearAmber);
    }
  };
  startEl.addEventListener("change", _clearAmber);

  const hintText =
    _val("leaseStartDateHint") ||
    "The start date is not stated in the document.";
  const hint = document.createElement("div");
  hint.id = "startDateAiHint";
  hint.style.cssText =
    "margin-top:6px;padding:8px 10px;border:1px solid #E3B341;background:#FEF6E0;border-radius:6px;font-size:12px;line-height:1.45;color:#5c4400;";
  hint.innerHTML =
    "<strong>Start date not stated in the document.</strong> " +
    "Enter the actual start / handover date.<br>" +
    "<span style=\"color:#7a5a00;\">From the document: " +
    escapeHtml(hintText) +
    "</span>";
  (startEl.closest(".form-group") || startEl.parentNode).appendChild(hint);
}

function resolveAndSelectUnitBySuitId(suitId) {
  return resolveAndSelectUnitsByIdentifier([suitId]);
}

// -----------------------------------------------------------------------------
// LEASE OPTIONS AUTOFILL (Stage 6) - consumes window._pendingOptionsAutofill
// -----------------------------------------------------------------------------
async function _applyOptionsAutofill() {
  const list = window._pendingOptionsAutofill;
  if (!list || !list.length) return;
  window._pendingOptionsAutofill = null;
  window.sessionLeaseOptions = window.sessionLeaseOptions || [];

  // Ensure choice + currency caches are loaded for text -> value resolution.
  try {
    if (
      (!window.optionTypes || !window.optionTypes.length) &&
      typeof loadOptionTypes === "function"
    )
      window.optionTypes = await loadOptionTypes();
  } catch (e) {
    /* matching degrades to text-only */
  }
  try {
    if (
      (!window.optionHolderTypes || !window.optionHolderTypes.length) &&
      typeof loadOptionHolderTypes === "function"
    )
      window.optionHolderTypes = await loadOptionHolderTypes();
  } catch (e) {
    /* matching degrades to text-only */
  }
  try {
    if (
      (!window.currencies || !window.currencies.length) &&
      typeof loadCurrencies === "function"
    )
      window.currencies = await loadCurrencies();
  } catch (e) {
    /* currency stays unresolved */
  }

  const leaseStart = document.getElementById("startDate")?.value || "";
  const leaseEnd = document.getElementById("endDate")?.value || "";

  let added = 0;
  for (const o of list) {
    const typeObj = _afMatchChoice(window.optionTypes, _afVal(o.optionType));
    const holderObj = _afMatchChoice(
      window.optionHolderTypes,
      _afVal(o.optionHolder),
    );

    const currTxt = _afVal(o.penaltyCurrency);
    const currObj = currTxt
      ? (window.currencies || []).find(
          (c) =>
            (c.isocurrencycode || "").toLowerCase() === currTxt.toLowerCase() ||
            (c.currencyname || "").toLowerCase() === currTxt.toLowerCase(),
        )
      : null;

    const execDate = _afDateInput(_afVal(o.optionAvailableFrom)) || leaseStart;
    const expDate = _afDateInput(_afVal(o.optionExpiryDate)) || leaseEnd;
    const noticeDays = _afVal(o.noticePeriodDays);

    // Derive the notice submission deadline (Expiry - notice days) when possible.
    let noticeDate = "";
    const noticeDaysNum = parseInt(noticeDays, 10);
    if (expDate && !isNaN(noticeDaysNum) && noticeDaysNum >= 0) {
      const d = new Date(expDate);
      d.setDate(d.getDate() - noticeDaysNum);
      noticeDate = _afDateInput(d);
    }

    window.sessionLeaseOptions.push({
      optionType: typeObj ? String(typeObj.Value) : "",
      optionTypeName: typeObj ? _afChoiceLabel(typeObj) : _afVal(o.optionType),
      optionHolder: holderObj ? String(holderObj.Value) : "",
      optionHolderName: holderObj
        ? _afChoiceLabel(holderObj)
        : _afVal(o.optionHolder),
      penaltyAmount: _afVal(o.penaltyAmount),
      currencyId: currObj ? currObj.transactioncurrencyid : "",
      noticePeriod: noticeDays,
      executionDate: execDate,
      noticeDate: noticeDate,
      expirationDate: expDate,
      description: _afVal(o.description),
      // Dates not stated in the document -> defaulted from the lease; they
      // re-sync when the lease dates change (cleared when saved via the modal,
      // which rebuilds the option object).
      _defaulted: {
        executionDate: !_afDateInput(_afVal(o.optionAvailableFrom)),
        expirationDate: !_afDateInput(_afVal(o.optionExpiryDate)),
      },
    });
    added++;
  }

  if (typeof renderOptionsGrid === "function") renderOptionsGrid();
  if (added) {
    showNotification(
      `${added} lease option(s) pre-filled from document. Open each to review & complete.`,
      "info",
    );
  }
}

// -----------------------------------------------------------------------------
// FINANCIAL CLAUSE AUTOFILL (Stage 7) - consumes window._pendingClausesAutofill
// -----------------------------------------------------------------------------

// Poll until the Stage 7 clause UI (checkboxes) has rendered.
async function _waitForClauseUI(maxMs = 4000) {
  const interval = 100;
  const maxIter = Math.ceil(maxMs / interval);
  for (let i = 0; i < maxIter; i++) {
    if (document.querySelector("[id^='clauseCheck-']")) return true;
    await _afSleep(interval);
  }
  return !!document.querySelector("[id^='clauseCheck-']");
}

async function _applyClausesAutofill() {
  const data = window._pendingClausesAutofill;
  if (!data) return;

  // Guard: clause checkboxes are checked/expanded/filled asynchronously below
  // (with sleeps). validateCurrentStage() blocks leaving Stage 7 while this is
  // true, so a fast Next-click can't advance past half-applied/empty clauses
  // and strand the in-flight apply on a hidden stage.
  window._clausesAutofillInProgress = true;
  try {
    const ready = await _waitForClauseUI();
    if (!ready) {
      console.warn("Clause UI not ready - skipping clause autofill.");
      return;
    }
    window._pendingClausesAutofill = null;

    if (Array.isArray(data.cpi) && data.cpi.length)
      await _fillClauseType(
        "Value Protection (CPI)",
        data.cpi,
        _fillCPIInstance,
      );
    if (Array.isArray(data.turnover) && data.turnover.length)
      await _fillClauseType(
        "Turnover Rent",
        data.turnover,
        _fillTurnoverInstance,
      );
    if (Array.isArray(data.stepRent) && data.stepRent.length)
      await _fillClauseType(
        "Step Rent Indexation",
        data.stepRent,
        _fillStepRentInstance,
      );

    const n =
      (data.cpi?.length || 0) +
      (data.turnover?.length || 0) +
      (data.stepRent?.length || 0);
    if (n) {
      showNotification(
        `${n} financial clause instance(s) pre-filled from document. Review each before saving.`,
        "info",
      );
    }
  } finally {
    window._clausesAutofillInProgress = false;
  }
}

// Checks the clause type, expands its form, ensures one instance block per data
// item, then delegates per-instance population to fillFn.
async function _fillClauseType(clauseType, instances, fillFn) {
  const checkbox = document.querySelector(
    `input[type="checkbox"][data-clause-type="${clauseType}"]`,
  );
  if (!checkbox) {
    console.warn(`Clause checkbox not found for "${clauseType}".`);
    return;
  }
  const safeType = checkbox.getAttribute("data-safe-type");

  if (!checkbox.checked) {
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
  }
  // Wait for the form to expand + setupClauseInteractivity (setTimeout 100) to wire toggles.
  await _afSleep(300);

  const form = document.getElementById(`clauseDetails-${safeType}`);
  if (!form) return;

  // Single-form clause types use a shared clause-level header date pair.
  // Instance-based types set dates per instance in the fill loop below.
  const first = instances[0] || {};
  const headerEff = form.querySelector(
    ".clause-header-dates .clause-effective-date",
  );
  const headerExp = form.querySelector(
    ".clause-header-dates .clause-expiry-date",
  );
  const eff = _afDateInput(_afVal(first.effectiveDate));
  const exp = _afDateInput(_afVal(first.expiryDate));
  if (headerEff && eff) {
    headerEff.value = eff;
    headerEff.setAttribute("data-user-modified", "true");
  }
  if (headerExp && exp) {
    headerExp.value = exp;
    headerExp.setAttribute("data-user-modified", "true");
  }

  const prefixMap = {
    "Value Protection (CPI)": "cpiFields",
    "Turnover Rent": "turnoverFields",
    "Step Rent Indexation": "stepRentFields",
  };
  const prefix = prefixMap[clauseType];

  // Instance 1 already exists; add (n-1) more via the "+ Add more" button.
  for (let i = 1; i < instances.length; i++) {
    const addBtn = Array.from(form.querySelectorAll(".add-instance-btn")).pop();
    if (addBtn) {
      addBtn.click();
      await _afSleep(150);
    }
  }

  const blocks = form.querySelectorAll(`[id^='${prefix}-']`);
  for (let i = 0; i < instances.length && i < blocks.length; i++) {
    // Per-instance effective / expiry dates.
    const ie = _afDateInput(_afVal(instances[i].effectiveDate));
    const ix = _afDateInput(_afVal(instances[i].expiryDate));
    const ieEl = blocks[i].querySelector(".clause-effective-date");
    const ixEl = blocks[i].querySelector(".clause-expiry-date");
    // No document date but a lease-relative offset (e.g. a cap that applies
    // only in lease years 1-2 -> instance 1: 0..24 months, instance 2: 24..end):
    // remember the offset; the date resolves from the lease start now and
    // whenever the lease dates change.
    const ieOff = _afVal(instances[i].effectiveOffsetMonths);
    const ixOff = _afVal(instances[i].expiryOffsetMonths);
    if (ieEl && ie) {
      ieEl.value = ie;
      ieEl.setAttribute("data-user-modified", "true");
    } else if (ieEl && /^\d+$/.test(ieOff)) {
      ieEl.dataset.leaseOffsetMonths = ieOff;
    }
    if (ixEl && ix) {
      ixEl.value = ix;
      ixEl.setAttribute("data-user-modified", "true");
    } else if (ixEl && /^\d+$/.test(ixOff)) {
      ixEl.dataset.leaseOffsetMonths = ixOff;
    }
    await fillFn(blocks[i], instances[i]);
  }
  _resyncClauseDates();
}

async function _fillCPIInstance(block, inst) {
  const setVal = (sel, v) => {
    const el = block.querySelector(sel);
    if (el && v !== "" && v != null) el.value = v;
  };

  setVal(".initial-waiting-period-input", _afVal(inst.initialWaitingPeriod));

  // CPI Type is the only select not carrying a dedicated class. Set WITHOUT firing
  // change to avoid the auto-index fetch overwriting the document's Current Index.
  const cpiTypeSel = block.querySelectorAll(
    "select:not(.increase-type-cpi-select):not(.charge-type-cpi-select):not(.cpi-rent-frequency-select)",
  )[0];
  _afSetSelectByText(cpiTypeSel, _afVal(inst.cpiType));

  _afSetChargeTypeSelect(
    block.querySelector(".charge-type-cpi-select"),
    _afVal(inst.chargeType),
  );

  // Increase Type - fire change so flat/percent conditional fields reveal.
  const incEl = block.querySelector(".increase-type-cpi-select");
  if (
    _afSetSelectByText(incEl, _afVal(inst.increaseType), { fireChange: true })
  )
    await _afSleep(60);

  // Flat / Min / Max fields are revealed by the Increase Type change above.
  setVal("[id^='cpiFlatAmountField-'] input", _afVal(inst.flatAmountCPI));
  setVal(
    "[id^='cpiMinFlatAmountField-'] input",
    _afVal(inst.minimumIncreaseFlatAmountCPI),
  );
  setVal(
    "[id^='cpiMinPercentField-'] input",
    _afVal(inst.minimumIncreasePercentage),
  );
  setVal(
    "[id^='cpiMaxPercentField-'] input",
    _afVal(inst.maximumIncreasePercentage),
  );

  setVal(".min-time-interval-input", _afVal(inst.minimumTimeInterval));
  setVal(".trigger-value-input", _afVal(inst.triggerValue));
  // Form choices are Monthly / Quarterly / Half-Yearly / Yearly. Older prompt
  // output used Annual / Semi-Annual, which never matched - alias them.
  const _cpiFreqAlias = {
    annual: "Yearly",
    annually: "Yearly",
    yearly: "Yearly",
    "semi-annual": "Half-Yearly",
    "semi annual": "Half-Yearly",
    "half-yearly": "Half-Yearly",
    "half yearly": "Half-Yearly",
    quarterly: "Quarterly",
    monthly: "Monthly",
  };
  const _cpiFreqRaw = _afVal(inst.cpiRentFrequency);
  _afSetSelectByText(
    block.querySelector(".cpi-rent-frequency-select"),
    _cpiFreqAlias[_afNorm(_cpiFreqRaw)] || _cpiFreqRaw,
  );

  // CPI Reference Month / Custom Month / Skip First CPI Schedule.
  // Apply the frequency rules first so the Reference Month options exist.
  // Accepts a label ("Custom Month", "June") or the choice value ("3", "6").
  const setChoice = (sel, v) => {
    if (!sel || v === "") return false;
    if (/^\d+$/.test(v) && Array.from(sel.options).some((o) => o.value === v)) {
      sel.value = v;
      return true;
    }
    return _afSetSelectByText(sel, v);
  };
  _applyCpiReferenceMonthRules(block);
  if (
    setChoice(
      block.querySelector(".cpi-reference-month-select"),
      _afVal(inst.cpiReferenceMonth),
    )
  )
    _applyCpiReferenceMonthRules(block); // reveals Custom Month when applicable
  setChoice(
    block.querySelector(".cpi-custom-month-select"),
    _afVal(inst.cpiCustomMonth),
  );
  const sft = block.querySelector(".skip-first-cpi-toggle");
  if (sft && _afBool(inst.skipFirstCpiSchedule)) {
    sft.checked = true;
    sft.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Current Index: only the document value is used. When the document states
  // no base index the field is left EMPTY for the user (no current-month
  // lookup - today's index is not the lease's base index).
  const ci = block.querySelector("input[id^='currentIndexInput-']");
  const ciVal = _afVal(inst.currentIndex);
  if (ci) {
    const ciNum = ciVal !== "" ? Number(String(ciVal).replace(",", ".")) : NaN;
    if (!isNaN(ciNum)) {
      ci.value = ciNum;
      ci.dataset.cpiIndexSource = "ai";
    } else {
      ci.value = "";
      ci.dataset.cpiIndexSource = "";
      ci.placeholder = "Base index not stated in document - enter manually";
    }
  }

  const tog = block.querySelector(".custom-cpi-toggle");
  if (tog && _afBool(inst.enableCustomSchedule)) {
    tog.checked = true;
    tog.dispatchEvent(new Event("change", { bubbles: true }));
  }

  const sm = block.querySelector(".cpi-clause-summary");
  if (sm) sm.value = _afVal(inst.clauseSummary);
}

async function _fillTurnoverInstance(block, inst) {
  const vat = block.querySelector(".vat-toggle");
  if (vat && _afBool(inst.subjectToVAT)) {
    vat.checked = true;
    vat.dispatchEvent(new Event("change", { bubbles: true }));
    await _afSleep(40);
  }
  const ocr = block.querySelector(".ocr-toggle");
  if (ocr && _afBool(inst.enableOCR)) {
    ocr.checked = true;
    ocr.dispatchEvent(new Event("change", { bubbles: true }));
    await _afSleep(40);
  }
  const pro = block.querySelector(".proration-toggle");
  if (pro && _afBool(inst.enableProration)) {
    pro.checked = true;
    pro.dispatchEvent(new Event("change", { bubbles: true }));
  }
  const cust = block.querySelector(".custom-turnover-toggle");
  if (cust && _afBool(inst.enableCustomSchedule)) {
    cust.checked = true;
    cust.dispatchEvent(new Event("change", { bubbles: true }));
  }

  _afSetSelectByText(
    block.querySelector(".turnover-basis-select"),
    _afVal(inst.turnoverRentBasis),
  );
  _afSetSelectByText(
    block.querySelector(".currency-select"),
    _afVal(inst.currency),
  );
  _afSetChargeTypeSelect(
    block.querySelector(".charge-type-turnover-select"),
    _afVal(inst.chargeTypeAdvance),
  );
  _afSetSelectByText(
    block.querySelector(".turnover-settlement-select"),
    _afVal(inst.settlementCycle),
  );
  _afSetSelectByText(
    block.querySelector(".turnover-reporting-select"),
    _afVal(inst.reportingCycle),
  );
  _afSetSelectByText(
    block.querySelector(".turnover-calc-type-select"),
    _afVal(inst.turnoverRentCalculationType),
  );

  // Increase Type - fire change so flat/percent conditional fields reveal.
  if (
    _afSetSelectByText(
      block.querySelector(".turnover-increase-select"),
      _afVal(inst.increaseType),
      { fireChange: true },
    )
  )
    await _afSleep(60);

  const st = block.querySelector(".sales-threshold-input");
  const stVal = _afVal(inst.salesThreshold);
  if (st && stVal !== "") st.value = stVal;

  const sm = block.querySelector(".turnover-clause-summary");
  if (sm) sm.value = _afVal(inst.clauseSummary);
}

async function _fillStepRentInstance(block, inst) {
  _afSetChargeTypeSelect(
    block.querySelector(".charge-type-step-select"),
    _afVal(inst.chargeType || inst.chargeTypeStepIncrease),
  );

  // Increase Type - fire change so flat/percent conditional fields reveal.
  const incEl =
    block.querySelector(".increase-type-step-select") ||
    block.querySelector("select[id^='increaseType-']");
  if (
    _afSetSelectByText(incEl, _afVal(inst.increaseType), { fireChange: true })
  )
    await _afSleep(60);

  const flat = _afVal(inst.flatAmount);
  if (flat !== "") {
    const fi = block.querySelector("[id^='flatField-'] input");
    if (fi) fi.value = flat;
  }
  const pct = _afVal(inst.stepRentPercentage || inst.percentage);
  if (pct !== "") {
    const pi = block.querySelector("[id^='percentField-'] input");
    if (pi) pi.value = pct;
  }

  _afSetSelectByText(
    block.querySelector(".step-rent-frequency-select"),
    _afVal(inst.stepRentFrequency || inst.frequency),
  );

  const tog = block.querySelector(".custom-step-toggle");
  if (tog && _afBool(inst.enableCustomSchedule)) {
    tog.checked = true;
    tog.dispatchEvent(new Event("change", { bubbles: true }));
  }

  const sm = block.querySelector(".step-clause-summary");
  if (sm) sm.value = _afVal(inst.clauseSummary);
}

function _uint8ArrayToBase64(bytes) {
  const CHUNK = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// Autofill from flow - entry point wired to the file input / drop zone.
// Guards against a re-upload silently merging into already-filled data: if a prior
// autofill has run, confirm with the user that everything will be reset first.
async function triggerAutofillFlow(inputElement) {
  const file = inputElement.files[0];
  if (!file) return;

  if (file.type !== "application/pdf") {
    showNotification("Please upload a valid PDF file.", "error");
    inputElement.value = "";
    return;
  }

  // Clear the input immediately so the SAME file can be re-selected later
  // (a file <input> won't fire change for an unchanged value). We pass the
  // captured `file` onward, so clearing here is safe.
  inputElement.value = "";

  // Re-upload guard: the form already carries autofilled data -> confirm a reset
  // before wiping it and processing the new document.
  if (window._autofillHasRun) {
    showDeleteConfirm(
      "Replace document & reset form?",
      "You've already autofilled this lease from a document. Uploading a new file will clear ALL currently entered data and start over from Basic Info. Do you want to continue?",
      () => {
        confirmReset(); // wipe everything back to a clean Stage 1
        _executeAutofillFlow(file);
      },
      "Yes, Reset & Continue",
    );
    return;
  }

  _executeAutofillFlow(file);
}

// Runs the actual extraction flow for an already-validated PDF File.
async function _executeAutofillFlow(file) {
  showAutofillProgress("Reading document and extracting data...");

  // -- Timing tracer: locate the multi-second delay. Each upload resets the clock.
  window._flowReset();
  window._flowLog(
    "upload started - file: " +
      file.name +
      " (" +
      Math.round(file.size / 1024) +
      " KB)",
  );

  // Clear any deferred autofill data from a previous upload so stale charges/
  // deposits/options/clauses can't merge into this run.
  window._agent1ChargeCodes = [];
  window._pendingChargesAutofill = null;
  window._pendingSecurityAutofill = null;
  window._pendingOptionsAutofill = null;
  window._pendingClausesAutofill = null;
  window._pendingDiscountsAutofill = null;

  // Reset any prior background-pass state; payload is set inside the try once
  // the main agent's flags are known, then fired in finally.
  window._subAgentFlowState = "idle";
  // Marks the main extraction as in-flight so validateCurrentStage can block the
  // user from skipping past autofill-target stages before the data lands.
  window._autofillMainInFlight = true;
  let _subAgentPayload = null;

  try {
    const arrayBuffer = await file.arrayBuffer();
    window._flowLog("file read into ArrayBuffer");
    const fileContent = _uint8ArrayToBase64(new Uint8Array(arrayBuffer));
    // Retain the uploaded document so it can be saved to SharePoint at submit
    // time. Its presence also marks this lease to activate on submit (and to
    // skip the signing widget).
    window._autofillDocument = {
      fileName: file.name,
      fileContent,
      fileType: file.type || "application/pdf",
    };
    window._flowLog(
      "base64 encoded (" +
        Math.round(fileContent.length / 1024) +
        " KB string)",
    );

    // Hand the uploaded PDF to the side-by-side preview pane (clone the
    // buffer because pdf.js neuters the typed array it receives).
    try {
      if (window.LeasePdfPreview) {
        window.LeasePdfPreview.load(arrayBuffer.slice(0), file.name);
      }
    } catch (e) {
      /* preview is best-effort, never block autofill */
    }
    window._flowLog("PDF preview loaded; sending POST to main flow...");

    const AUTOFILL_FLOW_URL = await getEnvVarValue(AUTOFILL_FLOW_ENV_VAR);
    const response = await fetch(AUTOFILL_FLOW_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: file.name,
        fileContent,
      }),
    });
    window._flowLog("main flow responded (HTTP " + response.status + ")");

    if (!response.ok) throw new Error("Failed to process the document.");

    const _flowRaw = await response.json();
    window._flowLog("response JSON parsed; applying fields...");
    // Main-agent flow response. Tolerate every shape the flow may emit:
    //   * [ mainObject, { ocrText } ]                 (flat)
    //   * [ [ mainObject ], { ocrText } ]             (main wrapped in an inner array)
    //   * { statusCode, schema, body: [ ... ] }       (HTTP envelope around either)
    // Strategy: unwrap a possible envelope, then flatten array nesting into a
    // flat list of objects (object internals like charges[] are NOT descended
    // into - recursion only follows arrays passed to it). The main object is
    // the first entry without an `ocrText` key; the OCR container is the one
    // that has it.
    const _payload =
      _flowRaw && !Array.isArray(_flowRaw) && _flowRaw.body != null
        ? _flowRaw.body
        : _flowRaw;
    const _flat = [];
    (function _collect(node) {
      if (Array.isArray(node)) node.forEach(_collect);
      else if (node && typeof node === "object") _flat.push(node);
    })(_payload);

    const flowData = _flat.find((e) => !("ocrText" in e)) || _flat[0] || {};

    // Pull the OCR text from wherever it lives (its own entry, or inlined).
    const _ocrEntry = _flat.find((e) => typeof e.ocrText === "string");
    const ocrText =
      (_ocrEntry && _ocrEntry.ocrText) ||
      (typeof flowData.ocrText === "string" ? flowData.ocrText : "") ||
      "";

    // Feed the OCR tab in the side-by-side preview pane (best-effort).
    try {
      if (
        window.LeasePdfPreview &&
        typeof window.LeasePdfPreview.setOcrText === "function"
      ) {
        window.LeasePdfPreview.setOcrText(ocrText);
      }
    } catch (e) {
      /* OCR display is best-effort, never block autofill */
    }

    // Discounts / lease options / financial clauses are NEVER inline in the
    // main flow - they come only from the background sub-agent flow below.
    const clauseOptionsData = null;
    console.log("Flow extracted data:", {
      main: flowData,
      ocrChars: ocrText.length,
    });

    // -----------------------------------------------------------
    // DATA MAPPING DICTIONARY (MATCHED TO HTML MODDED.HTML)
    // -----------------------------------------------------------
    const fieldMapping = {
      // Stage 1 & 2: Main Form Fields
      leaseName: "leaseName",
      leaseType: "leaseType",
      leaseTermType: "leaseTermType",
      leaseTerm: "leaseTerm",
      Tenant: "tenantDisplay",
      brandName: "brandNameDisplay",
      primaryContact: "contactDisplay",
      Property: "propertyDisplay",
      Description: "description",
      leaseStartDate: "startDate",
      leaseEndDate: "endDate",
      moveInDate: "moveInDate",
      // "selectUnit" is handled separately via array_suitid lookup (resolveAndSelectUnitBySuitId)
      totalAreaSqM: "totalUnitsArea",

      // Charge fields are handled separately via _pendingChargesAutofill (see below)
      // Security deposit fields are handled separately via _pendingSecurityAutofill (see below)

      // Options / Penalty
      optionType: "optionType",
      optionHolder: "optionHolder",
      penaltyAmount: "optionPenalty",
    };

    // Loop through the dictionary and fill the form
    window._flowLog(
      "field-mapping loop start (incl. Tenant/Property Dataverse lookups)",
    );
    for (const [jsonKey, htmlId] of Object.entries(fieldMapping)) {
      const fieldData = flowData[jsonKey];
      const rawValue =
        fieldData && fieldData.value != null ? fieldData.value : null;
      if (rawValue === null || String(rawValue).trim() === "") continue;

      {
        const inputElement = document.getElementById(htmlId);

        if (inputElement) {
          let finalValue = String(rawValue).trim();
          let resolvedRecord = null;

          // --- LOOKUP RESOLVER LOGIC ---
          if (jsonKey === "Tenant" || jsonKey === "Property") {
            // Turn the box yellow to indicate processing
            inputElement.style.backgroundColor = "#fef08a";

            const lookupType = jsonKey === "Tenant" ? "Tenant" : "Property";
            resolvedRecord = await resolveDataverseLookup(
              finalValue,
              lookupType,
            );

            if (resolvedRecord) {
              // 80%+ Match found! Use the perfect Dataverse name
              finalValue = resolvedRecord.name;

              // 1. CALL YOUR NATIVE UI SELECTION FUNCTIONS
              if (jsonKey === "Tenant") {
                // Calls the function you provided exactly as your HTML does
                selectTenant(
                  resolvedRecord.id,
                  resolvedRecord.name,
                  resolvedRecord.logicalName,
                );
              } else if (jsonKey === "Property") {
                selectProperty(resolvedRecord.id, resolvedRecord.name);
              }

              // 2. Store the GUID in HTML attributes as a safety backup
              inputElement.setAttribute("data-record-id", resolvedRecord.id);
              inputElement.setAttribute(
                "data-logical-name",
                resolvedRecord.logicalName,
              );
            }
          }

          // --- DATE FORMATTER ---
          if (inputElement.type === "date") {
            const parsedDate = new Date(finalValue);
            if (!isNaN(parsedDate.getTime())) {
              const yyyy = parsedDate.getFullYear();
              const mm = String(parsedDate.getMonth() + 1).padStart(2, "0");
              const dd = String(parsedDate.getDate()).padStart(2, "0");
              finalValue = `${yyyy}-${mm}-${dd}`;
            }
          }

          // Set the value in the UI
          if (inputElement.tagName === "SELECT") {
            const match = Array.from(inputElement.options).find(
              (opt) =>
                opt.textContent.trim().toLowerCase() ===
                finalValue.toLowerCase(),
            );
            if (match) inputElement.value = match.value;
          } else {
            inputElement.value = finalValue;
          }

          // --- VISUAL FEEDBACK ---
          if (resolvedRecord) {
            // Perfect Match: Turn Green
            inputElement.style.backgroundColor = "#bbf7d0";
          } else if (jsonKey === "Tenant" || jsonKey === "Property") {
            // Ambiguous AI Match: Turn light red/pink to prompt user search
            inputElement.style.backgroundColor = "#fecdd3";

            // Clear any old hidden GUIDs so they don't accidentally save bad data
            inputElement.removeAttribute("data-record-id");
          } else {
            // Standard Field: Turn Light Blue
            inputElement.style.backgroundColor = "#e0f2fe";
          }

          inputElement.setAttribute("data-user-input", "true");

          // Fire native change events
          inputElement.dispatchEvent(new Event("change", { bubbles: true }));

          // Slowly fade the highlight out after 3 seconds
          setTimeout(() => {
            inputElement.style.transition = "background-color 0.5s ease";
            inputElement.style.backgroundColor = "";
          }, 3000);
        }
      }
    }
    // -----------------------------------------------------------
    window._flowLog("field-mapping loop done");

    // Undetermined start date: the form defaults Start Date to today on open,
    // and the loop above skips null values - so a lease whose start depends on
    // a future event (e.g. handover per landlord notice) would silently save
    // with today's date. Clear it, flag it, and show the document's context.
    _applyUndeterminedStartDate(flowData);

    // Resolve & auto-select unit(s). Supports the new multi-unit `leaseUnits`
    // array and the legacy single `selectUnit`. Runs after the field loop so the
    // Property lookup has already resolved (used to scope the unit query).
    {
      const _unitIds = [];
      if (Array.isArray(flowData.leaseUnits)) {
        flowData.leaseUnits.forEach((u) => {
          const v = _afVal(u && u.unitName);
          if (v) _unitIds.push(v);
        });
      } else if (_afVal(flowData.selectUnit)) {
        _unitIds.push(_afVal(flowData.selectUnit));
      }
      if (_unitIds.length) {
        window._flowLog(
          "resolving " + _unitIds.length + " unit(s) via Dataverse...",
        );
        await resolveAndSelectUnitsByIdentifier(_unitIds);
        window._flowLog("unit resolution done");
      }
    }

    // Keep Agent 1's charge codes for aligning Agent 2 clause charge types
    // (see _alignAgent2ChargeCode). Survives the Stage 3 charges autofill.
    window._agent1ChargeCodes = Array.isArray(flowData.charges)
      ? flowData.charges
          .map((c) =>
            c && c.chargeType && c.chargeType.value != null
              ? String(c.chargeType.value).trim()
              : "",
          )
          .filter(Boolean)
      : [];

    // Collect charge records for Stage 3 pre-fill (charges is now an array)
    if (Array.isArray(flowData.charges) && flowData.charges.length > 0) {
      window._pendingChargesAutofill = flowData.charges.map((c) => {
        const _v = (obj) =>
          obj && obj.value != null ? String(obj.value).trim() : "";
        return {
          chargeName: _v(c.chargeName),
          chargeType: _v(c.chargeType),
          chargeCurrency: _v(c.Currency),
          chargeAmount: _v(c.chargeAmount),
          chargeStartDate: _v(c.chargeStartDate),
          chargeEndDate: _v(c.chargeEndDate),
          Frequency: _v(c.Frequency),
          vatPercent: _v(c.vatPercent),
          billableArea: _v(c.billableArea),
          taxIncluded: _v(c.taxIncluded),
          proratedEnabled: _v(c.proratedEnabled),
          exchangeRateRule: _v(c.exchangeRateRule),
          ratePerSqM: _v(c.ratePerSqM),
          preFrequencyOffset: _v(c.preFrequencyOffset),
          dueDateRule: _v(flowData.dueDateRule),
          dueInDays: _v(flowData.dueInDays),
          invoiceGenDate: _v(flowData.invoiceGenDate),
          invoiceSeparately: _v(flowData.invoiceSeparately),
          bankAccount: _v(flowData.bankAccount),
        };
      });
    }

    // Collect security deposit records for Stage 4 pre-fill (securityDeposits is now an array)
    if (
      Array.isArray(flowData.securityDeposits) &&
      flowData.securityDeposits.length > 0
    ) {
      window._pendingSecurityAutofill = flowData.securityDeposits.map((s) => {
        const _v = (obj) =>
          obj && obj.value != null ? String(obj.value).trim() : "";
        return {
          securityType: _v(s.securityType),
          depositSubType: _v(s.depositSubType),
          depositRequiredAmount: _v(s.depositRequiredAmount),
          depositCurrency: _v(s.depositCurrency),
          Bank: _v(s.Bank),
          guaranteeNo: _v(s.guaranteeNo),
          startDate: _v(s.startDate),
          dueDate: _v(s.dueDate),
        };
      });
    }

    // Collect collateral calculation rules + configurations for Stage 3
    // pre-fill. Both arrive on the MAIN flow response (top-level), so they
    // are stashed here and applied lazily when the user reaches Stage 3
    // (mirrors _pendingChargesAutofill).
    if (
      (Array.isArray(flowData.collateralRules) &&
        flowData.collateralRules.length > 0) ||
      (Array.isArray(flowData.collateralConfigurations) &&
        flowData.collateralConfigurations.length > 0)
    ) {
      const _v = (obj) =>
        obj && obj.value != null ? String(obj.value).trim() : "";
      const _num = (obj) => {
        const n = parseFloat(obj && obj.value);
        return isNaN(n) ? null : n;
      };
      window._pendingCollateralAutofill = {
        rules: (flowData.collateralRules || []).map((r) => ({
          coefficient: _num(r.coefficient),
          chargeTypes: Array.isArray(r.chargeTypes)
            ? r.chargeTypes.map(_v).filter(Boolean)
            : [],
        })),
        configs: (flowData.collateralConfigurations || []).map((c) => ({
          coefficient: _num(c.coefficient),
          collateralType: _v(c.collateralType),
        })),
      };
    }

    // Discounts / lease options / financial clauses.
    // Two-agent flow: the main agent returns only boolean flags; a separate
    // sub-agent flow extracts these 3 sections and is fired in the background
    // below. Backward-compat: an older single-agent flow returned them inline
    // as response[1] (clauseOptionsData) - apply directly when present.
    if (clauseOptionsData) {
      _stashSubAgentData(clauseOptionsData);
      window._subAgentFlowState = "done";
    } else {
      window._pendingDiscountsAutofill = null;
      // Fire the sub-agent only when the main agent says there's something
      // to extract - and only after the main loader is dismissed (finally).
      if (
        _afBool(flowData.hasFinancialClauses) ||
        _afBool(flowData.hasLeaseOptions) ||
        _afBool(flowData.hasDiscount)
      ) {
        // Send the OCR text the main flow already returned instead of
        // re-uploading the full PDF - avoids a second OCR pass in the
        // sub-agent flow. The text is byte-identical to the main flow's
        // OCR output (tables preserved as pipe-delimited rows).
        _subAgentPayload = { fileName: file.name, ocrText };
      }
    }

    // Mark that a document has been processed so a subsequent upload prompts
    // the user to confirm a reset instead of merging into this data.
    window._autofillHasRun = true;

    window._flowLog(
      "main autofill COMPLETE" +
        (_subAgentPayload ? " - sub-agent flow will fire next" : ""),
    );
    showNotification("Data autofilled successfully!", "success");
  } catch (error) {
    console.error("Error triggering Power Automate flow:", error);
    window._flowLog("main autofill FAILED: " + (error && error.message));
    showNotification("Failed to extract data from the document.", "error");
  } finally {
    // Main pass is done. If a sub-agent pass fires below it sets its own
    // "running" state synchronously, so there is no unguarded gap.
    window._autofillMainInFlight = false;
    hideAutofillProgress();
    // (The file input was already cleared in triggerAutofillFlow.)
    // Background pass - no loader unless the user lands on a sub-agent stage.
    if (_subAgentPayload) {
      _startSubAgentAutofill(
        _subAgentPayload.fileName,
        _subAgentPayload.ocrText,
      );
    }
  }
}

// -----------------------------------------------------------------------------
// VERBATIM QUOTES FROM OCR
// Language models re-generate long quotes (and can change words, e.g. "Najemca"
// -> "Wynajmujący"). The agent therefore returns quoteStart / quoteEnd anchors
// (first / last ~8 words of the clause) and the exact text is cut from the OCR.
// Matching ignores case, punctuation and whitespace; the slice itself is the
// original OCR text. If the anchors are not found, the agent's own quote is
// kept only when it can be verified against the OCR; otherwise it is flagged.
// -----------------------------------------------------------------------------
// Fold one character for matching: lower case, no diacritics (ą->a, ł->l),
// so OCR or model diacritic slips (postanawiają / postanawiaja) still match.
function _foldChar(ch) {
  return ch
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/ł/g, "l");
}

function _ocrNormIndex(text) {
  // Normalised string (letters/digits, single spaces, folded) + a map from
  // each normalised char back to its index in the original text.
  let norm = "";
  const map = [];
  let lastSpace = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/[\p{L}\p{N}]/u.test(ch)) {
      for (const c of _foldChar(ch)) {
        norm += c;
        map.push(i);
      }
      lastSpace = false;
    } else if (!lastSpace) {
      norm += " ";
      map.push(i);
      lastSpace = true;
    }
  }
  return { norm, map };
}

function _normPhrase(t) {
  return Array.from(String(t || ""))
    .map((ch) => (/[\p{L}\p{N}]/u.test(ch) ? _foldChar(ch) : " "))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

// Find a phrase; if not found, retry with fewer words from the anchored side
// (start phrase keeps its beginning, end phrase keeps its ending), min 4 words.
function _findPhrase(norm, phrase, fromIdx, keep) {
  const words = _normPhrase(phrase).split(" ").filter(Boolean);
  for (let n = words.length; n >= Math.min(4, words.length) && n > 0; n--) {
    const part = (
      keep === "start" ? words.slice(0, n) : words.slice(words.length - n)
    ).join(" ");
    const at = norm.indexOf(part, fromIdx);
    if (at !== -1) return { at, len: part.length };
  }
  return null;
}

function _resolveDiscountQuotes(discounts, ocr) {
  if (!Array.isArray(discounts) || !discounts.length) return discounts;
  if (!ocr) {
    discounts.forEach((d) => d && (d._quoteUnverified = true));
    return discounts;
  }
  const { norm, map } = _ocrNormIndex(ocr);
  const MAX_SPAN = 8000; // a clause never spans more than this many characters
  const _usedSlices = new Set(); // OCR slices already given to a discount

  discounts.forEach((d) => {
    if (!d) return;
    const qs = _afVal(d.quoteStart);
    const qe = _afVal(d.quoteEnd);
    let resolved = "";

    if (qs && qe) {
      const st = _findPhrase(norm, qs, 0, "start");
      if (st) {
        const en = _findPhrase(norm, qe, st.at, "end");
        if (en && en.at + en.len - st.at <= MAX_SPAN) {
          const from = map[st.at];
          const toNorm = Math.min(en.at + en.len - 1, map.length - 1);
          let to = map[toNorm] + 1;
          // keep the closing punctuation of the clause (". ; ) ”")
          while (to < ocr.length && /[.;:)\]”"’']/.test(ocr[to])) to++;
          resolved = ocr.slice(from, to).trim();
        }
      }
    }

    // Same anchors as an earlier discount (e.g. two discounts in one paragraph):
    // the slice would repeat the other record's text. Prefer this record's own
    // quote when it is verifiable in the OCR; otherwise flag it for review.
    if (resolved && _usedSlices.has(resolved)) {
      const ownQ = _normPhrase(_afVal(d.originalText));
      if (ownQ && norm.includes(ownQ)) {
        d._quoteFromOcr = true;
        return;
      }
      d._quoteDuplicate = true;
      d._quoteUnverified = true;
      console.warn("Discount quote duplicates another discount - flagged.", {
        quoteStart: qs,
        quoteEnd: qe,
      });
    }

    if (resolved) {
      _usedSlices.add(resolved);
      d.originalText = { value: resolved, confidence: 1 };
      if (!d._quoteDuplicate) d._quoteFromOcr = true;
      return;
    }

    // Fallback: keep the agent's quote only if it really occurs in the OCR.
    const own = _normPhrase(_afVal(d.originalText));
    if (own && norm.includes(own)) {
      d._quoteFromOcr = true;
    } else {
      d._quoteUnverified = true;
      console.warn(
        "Discount quote could not be matched to the OCR text - flagged for review.",
        { quoteStart: qs, quoteEnd: qe },
      );
    }
  });
  return discounts;
}

// Stash sub-agent extraction results into the deferred-autofill globals that
// goToStage consumes when the user reaches Discounts / Options / Clauses.
function _stashSubAgentData(d) {
  if (!d) return;
  const _arr = (k) => (Array.isArray(d[k]) ? d[k] : []);

  const _cpi = _arr("valueCPI");
  const _turnover = _arr("turnoverRent");
  const _stepRent = _arr("stepRentIndexation");
  if (_cpi.length || _turnover.length || _stepRent.length) {
    window._pendingClausesAutofill = {
      cpi: _cpi,
      turnover: _turnover,
      stepRent: _stepRent,
    };
  }

  const _options = _arr("leaseOptions");
  if (_options.length > 0) {
    window._pendingOptionsAutofill = _options;
    // Apply straight away - options are plain data in sessionLeaseOptions and
    // do not need Stage 6 to be open. Previously they waited for a Stage 6
    // entry, and a missed timing window left the grid empty.
    Promise.resolve()
      .then(() => _applyOptionsAutofill())
      .catch((e) => console.error("Lease options autofill failed:", e));
  }

  // Conditional discounts: surfaced read-only in the Discount stage for review.
  // originalText is cut from the OCR text by the agent's start/end anchors so
  // the quote is the document's exact wording, not model-regenerated text.
  const _discounts = _resolveDiscountQuotes(
    _arr("discounts"),
    window._lastOcrText || "",
  );
  window._pendingDiscountsAutofill = _discounts.length ? _discounts : null;
  console.log("Sub-agent autofill stashed:", {
    clauses: _cpi.length + _turnover.length + _stepRent.length,
    options: _options.length,
    discounts: _discounts.length,
  });
}

// Background pass: fetch the sub-agent flow and stash its results. No loader is
// shown unless the user is already on (or navigates to) a sub-agent stage.
async function _startSubAgentAutofill(fileName, ocrText) {
  // Run token: a response from an earlier upload (or one that finishes after a
  // Reset) must not overwrite the current form.
  const _runId = (window._subAgentRunId = (window._subAgentRunId || 0) + 1);
  window._subAgentFlowState = "running";
  // Kept for post-processing the sub-agent output (verbatim discount quotes).
  window._lastOcrText = typeof ocrText === "string" ? ocrText : "";

  // If the user is already waiting on Discounts / Options / Clauses, surface
  // the loader on that stage right away.
  if (_SUBAGENT_STAGES.includes(currentStage)) {
    showAutofillProgress(
      "Extracting discounts, options & financial clauses...",
    );
  }

  window._flowLog("sub-agent flow: sending POST...");
  try {
    const AUTOFILL_SUBAGENT_FLOW_URL = await getEnvVarValue(
      AUTOFILL_SUBAGENT_FLOW_ENV_VAR,
    );
    const response = await fetch(AUTOFILL_SUBAGENT_FLOW_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Array body - matches the HTTP trigger schema: [{ fileName, ocrText }]
      body: JSON.stringify([{ fileName, ocrText }]),
    });
    window._flowLog("sub-agent flow responded (HTTP " + response.status + ")");
    if (!response.ok) throw new Error("Sub-agent flow failed.");

    const raw = await response.json();
    if (_runId !== window._subAgentRunId) {
      window._flowLog("sub-agent flow: stale response ignored (run " + _runId + ")");
      return;
    }
    const data = Array.isArray(raw) ? raw[0] || {} : raw;
    _stashSubAgentData(data);
    window._subAgentFlowState = "done";
    window._flowLog("sub-agent flow COMPLETE");
    _applySubAgentForCurrentStage();
  } catch (err) {
    if (_runId !== window._subAgentRunId) return; // stale run - stay silent
    console.error("Sub-agent autofill failed:", err);
    window._flowLog("sub-agent flow FAILED: " + (err && err.message));
    window._subAgentFlowState = "error";
    if (_SUBAGENT_STAGES.includes(currentStage)) hideAutofillProgress();
    showNotification(
      "Could not auto-extract discounts/options/clauses. You can enter them manually.",
      "warning",
    );
  }
}

// Called when the sub-agent finishes. Applies its data immediately only if the
// user is currently on a sub-agent stage (otherwise goToStage applies it lazily).
function _applySubAgentForCurrentStage() {
  if (!_SUBAGENT_STAGES.includes(currentStage)) return;
  hideAutofillProgress(); // clear the stage loader if one was shown
  if (currentStage === 4) renderAutofillDiscountsPanel();
  // Options are applied on arrival (_stashSubAgentData); re-render if visible.
  if (currentStage === 6) {
    if (window._pendingOptionsAutofill) _applyOptionsAutofill();
    else if (typeof renderOptionsGrid === "function") renderOptionsGrid();
  }
  if (currentStage === 7 && window._pendingClausesAutofill)
    _applyClausesAutofill();
  showNotification("Discounts, options & clauses extracted.", "success");
}

document.addEventListener("DOMContentLoaded", function () {
  const uploadBar = document.querySelector(".upload-autofill-bar");
  if (uploadBar) {
    uploadBar.addEventListener("dragover", (e) => {
      e.preventDefault();
      uploadBar.style.backgroundColor = "#bae6fd";
      uploadBar.style.borderColor = "#0369a1";
    });
    uploadBar.addEventListener("dragleave", (e) => {
      e.preventDefault();
      uploadBar.style.backgroundColor = "#e0f2fe";
      uploadBar.style.borderColor = "#0284c7";
    });
    uploadBar.addEventListener("drop", (e) => {
      e.preventDefault();
      uploadBar.style.backgroundColor = "#e0f2fe";
      uploadBar.style.borderColor = "#0284c7";
      const fileInput = document.getElementById("leaseUploadInput");
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        fileInput.files = e.dataTransfer.files;
        triggerAutofillFlow(fileInput);
      }
    });
  }
});

// ==========================================
// STAGE 4: DISCOUNTS LOGIC
// ==========================================

function toggleDiscountChargeLookups() {
  const chargeType = document.getElementById("discountChargeType").value;
  const typeContainer = document.getElementById("specificTypeContainer");
  const chargeContainer = document.getElementById("specificChargeContainer");

  typeContainer.style.display = chargeType === "126330001" ? "block" : "none";
  chargeContainer.style.display = chargeType === "126330002" ? "block" : "none";
}

// ==========================================
// DISCOUNT MODAL & DROPDOWN LOGIC
// ==========================================

function openDiscountModal() {
  editingDiscountId = null;
  // Reset Modal Text
  document.querySelector("#discountModal .modal-header h3").innerText =
    "Add Discount";
  document.querySelector(
    "#discountModal .modal-footer .btn-primary",
  ).innerText = "Save Discount";
  // 1. Clear old values
  document.getElementById("discountChargeType").value = "";
  document.getElementById("discountType").value = "";
  document.getElementById("discountValue").value = "";
  document.getElementById("discountStartDate").value = "";
  document.getElementById("discountEndDate").value = "";

  // --- DEFAULT DATE AUTO-POPULATION ---
  const leaseStart = document.getElementById("startDate").value;
  const leaseEnd = document.getElementById("endDate").value;

  // Always auto-populate Start Date
  document.getElementById("discountStartDate").value = leaseStart || "";

  // Auto-populate End Date ONLY if Term Type is Fixed (126330001) or Fixed Rollover (126330002)
  const termSelect = document.getElementById("leaseTermType");
  const termVal = termSelect ? termSelect.value : "";

  if (termVal === "126330001" || termVal === "126330002") {
    document.getElementById("discountEndDate").value = leaseEnd || "";
  } else {
    document.getElementById("discountEndDate").value = "";
  }
  // -----------------------------------------

  // --- NEW: SPECIFIC CHARGE DATE OVERRIDE ---
  function autoPopulateChargeDates() {
    const chargeId = document.getElementById("discountRecurringCharge").value;
    if (!chargeId) return;

    // Find the charge in your Stage 3 array
    const selectedCharge = recurringCharges.find((c) => c.id == chargeId);

    if (selectedCharge) {
      // NOTE: If your stage 3 array uses different property names for dates (like .array_startdate), update them here:
      const cStart = selectedCharge.startDate || selectedCharge.array_startdate;
      const cEnd = selectedCharge.endDate || selectedCharge.array_enddate;

      if (cStart) document.getElementById("discountStartDate").value = cStart;
      if (cEnd) document.getElementById("discountEndDate").value = cEnd;
    }
  }

  toggleDiscountChargeLookups();
  // Hide the discount value field until a discount type is selected
  toggleDiscountValueType();

  // 2. Fetch the dropdown data fresh every time the modal opens!
  loadDiscountDropdowns();

  // 3. Show the modal
  document.getElementById("discountModal").style.display = "flex";
}

function closeDiscountModal() {
  document.getElementById("discountModal").style.display = "none";
}

async function editDiscount(id) {
  const disc = leaseDiscounts.find((d) => d.id === id);
  if (!disc) return;

  editingDiscountId = id; // Flag that we are editing

  // Update Modal Text
  document.querySelector("#discountModal .modal-header h3").innerText =
    "Edit Discount";
  document.querySelector(
    "#discountModal .modal-footer .btn-primary",
  ).innerText = "Update Discount";

  // Show modal and wait for dropdowns to load BEFORE setting their values
  document.getElementById("discountModal").style.display = "flex";
  await loadDiscountDropdowns();

  // Populate base fields
  document.getElementById("discountChargeType").value = disc.array_chargetype;
  document.getElementById("discountType").value = disc.array_discounttype;
  document.getElementById("discountStartDate").value = formatDateToInput(
    disc.array_startdate,
  );
  document.getElementById("discountEndDate").value = formatDateToInput(
    disc.array_enddate,
  );

  // Trigger UI toggles FIRST - toggleDiscountValueType() resets the value
  // input, so the discount value must be set AFTER these run (otherwise the
  // edited value renders blank).
  toggleDiscountChargeLookups();
  toggleDiscountValueType();
  document.getElementById("discountValue").value =
    disc.array_discountpercentage;

  // Populate the conditional lookups
  if (disc.array_chargetype === 126330001) {
    // Specific Type
    document.getElementById("discountChargeTypeCategory").value =
      disc._array_chargetypecategory_value;
  } else if (disc.array_chargetype === 126330002) {
    // Specific Charge
    document.getElementById("discountRecurringCharge").value =
      disc._array_recurringcharge_value;
  }
}

// Helper function to ensure dates from Dataverse/Array format correctly into HTML <input type="date">
function formatDateToInput(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  return d.toISOString().split("T")[0];
}

async function loadDiscountDropdowns() {
  // --- 1. Fetch Charge Types from Dataverse ---
  const categorySelect = document.getElementById("discountChargeTypeCategory");
  categorySelect.innerHTML = '<option value="">Loading Categories...</option>';

  try {
    // EXACT MATCH: Querying array_chargetype and selecting array_name
    const query =
      "?$select=array_chargetypeid,array_name&$filter=statecode eq 0";
    const results = await XrmContext.WebApi.retrieveMultipleRecords(
      "array_chargetype",
      query,
    );

    categorySelect.innerHTML = '<option value="">Select Category...</option>';

    results.entities.forEach((ent) => {
      // Using your exact primary column
      const categoryName = ent.array_name || "Unnamed Category";
      // Dataverse primary ID column
      categorySelect.innerHTML += `<option value="${ent.array_chargetypeid}">${categoryName}</option>`;
    });
  } catch (e) {
    console.error("Failed to load Charge Categories.", e);
    categorySelect.innerHTML =
      '<option value="" disabled>Error fetching from Dataverse</option>';
  }

  // --- 2. Load Recurring Charges from Stage 3 Array ---
  const chargeSelect = document.getElementById("discountRecurringCharge");
  chargeSelect.innerHTML =
    '<option value="">Select Recurring Charge...</option>';

  if (recurringCharges.length === 0) {
    chargeSelect.innerHTML +=
      '<option value="" disabled>Go back to Stage 3 and add a charge first</option>';
  } else {
    recurringCharges.forEach((charge) => {
      // Adjust to match whatever property holds the name in your array
      const chargeName =
        charge.name || charge.chargeTypeName || "Unnamed Charge";
      chargeSelect.innerHTML += `<option value="${charge.id}">${chargeName}</option>`;
    });
  }
}

function toggleDiscountValueType() {
  const discountType = document.getElementById("discountType").value;
  const label = document.getElementById("discountValueLabel");
  const input = document.getElementById("discountValue");
  const group = document.getElementById("discountValueGroup");
  input.value = "";

  if (discountType === "126330000") {
    // Flat
    label.innerHTML = 'Discount Amount <span class="required">*</span>';
    input.removeAttribute("max");
    input.min = "0";
    if (group) group.style.display = "block";
  } else if (discountType === "126330001") {
    // Percentage
    label.innerHTML = 'Discount Percentage <span class="required">*</span>';
    input.max = "100";
    input.min = "0";
    if (group) group.style.display = "block";
  } else {
    // No type selected - hide the value field until the user picks one
    if (group) group.style.display = "none";
  }
}

function addDiscount() {
  const leaseStartDateVal = document.getElementById("startDate").value; // Matches Stage 1 ID
  const leaseEndDateVal = document.getElementById("endDate").value; // Matches Stage 1 ID

  // Month-to-Month leases intentionally have no lease end date (hidden in Stage 1),
  // so only the start date is mandatory for them.
  const _leaseTermTypeSel = document.getElementById("leaseTermType");
  const isShortTerm =
    _leaseTermTypeSel &&
    (
      _leaseTermTypeSel.options[_leaseTermTypeSel.selectedIndex]?.textContent ||
      ""
    )
      .toLowerCase()
      .includes("month-to-month");

  if (!leaseStartDateVal || (!isShortTerm && !leaseEndDateVal)) {
    showNotification(
      isShortTerm
        ? "Please set the Lease Start Date in Stage 1 first."
        : "Please set the Lease Start/End Dates in Stage 1 first.",
      "warning",
    );
    return;
  }

  const chargeType = document.getElementById("discountChargeType").value;
  const discountType = document.getElementById("discountType").value;
  const value = parseFloat(document.getElementById("discountValue").value);
  const startDateVal = document.getElementById("discountStartDate").value;
  const endDateVal = document.getElementById("discountEndDate").value;

  if (
    !chargeType ||
    !discountType ||
    isNaN(value) ||
    !startDateVal ||
    !endDateVal
  ) {
    showNotification("Please fill in all required fields.", "error");
    return;
  }
  if (value <= 0)
    return showNotification("Discount value must be greater than 0.", "error");
  if (discountType === "126330001" && value > 100)
    return showNotification("Percentage cannot exceed 100%.", "error");

  const leaseStart = new Date(leaseStartDateVal);
  const leaseEnd = leaseEndDateVal ? new Date(leaseEndDateVal) : null;
  const discStart = new Date(startDateVal);
  const discEnd = new Date(endDateVal);

  if (discStart >= discEnd)
    return showNotification("Start Date must be before End Date.", "error");
  // For Month-to-Month leases there is no lease end date, so only enforce the lower bound.
  if (discStart < leaseStart || (leaseEnd && discEnd > leaseEnd))
    return showNotification(
      "Discount dates must be within Lease dates.",
      "error",
    );

  let typeCategoryId = null;
  let recurringChargeId = null;
  let displayTarget = "All Charges";

  // 1. Extract the specific IDs from the Dropdowns
  if (chargeType === "126330001") {
    // Specific Type
    const catSelect = document.getElementById("discountChargeTypeCategory");
    typeCategoryId = catSelect.value;
    if (!typeCategoryId)
      return showNotification("Select a Charge Type Category.", "error");
    displayTarget = catSelect.options[catSelect.selectedIndex].text;
  } else if (chargeType === "126330002") {
    // Specific Charge
    const chargeSelect = document.getElementById("discountRecurringCharge");
    recurringChargeId = chargeSelect.value;
    if (!recurringChargeId)
      return showNotification("Select a Recurring Charge.", "error");
    displayTarget = chargeSelect.options[chargeSelect.selectedIndex].text;
  }

  // 2. DUPLICATION VALIDATION (Configuration + Date Overlap)
  const newStart = new Date(startDateVal);
  const newEnd = new Date(endDateVal);

  const isDuplicate = leaseDiscounts.some((d) => {
    // Must be the same broad Charge Type
    if (d.array_chargetype !== parseInt(chargeType)) return false;

    let isSameConfig = false;

    // Check if the specific targets match
    if (chargeType === "126330000")
      isSameConfig = true; // All Charges
    else if (
      chargeType === "126330001" &&
      d._array_chargetypecategory_value === typeCategoryId
    )
      isSameConfig = true; // Specific Type
    else if (
      chargeType === "126330002" &&
      d._array_recurringcharge_value === recurringChargeId
    )
      isSameConfig = true; // Specific Charge

    //If we are editing, ignore the current record in the duplicate check!
    if (editingDiscountId && d.id === editingDiscountId) return false;

    // If the configuration matches, check if the Date Ranges OVERLAP
    if (isSameConfig) {
      const oldStart = new Date(d.array_startdate);
      const oldEnd = new Date(d.array_enddate);

      // Formula for date overlap: (Start A <= End B) AND (End A >= Start B)
      if (newStart <= oldEnd && newEnd >= oldStart) {
        return true; // Overlap found! It is a duplicate.
      }
    }

    return false; // Safe to add
  });

  if (isDuplicate) {
    showNotification(
      "A discount for this configuration already exists within an overlapping date range.",
      "warning",
    );
    return;
  }

  // Create and push the new discount array
  // 3. Create the data object
  const discountData = {
    array_chargetype: parseInt(chargeType),
    array_discounttype: parseInt(discountType),
    array_discountpercentage: value,
    array_startdate: startDateVal,
    array_enddate: endDateVal,
    _array_chargetypecategory_value: typeCategoryId,
    _array_recurringcharge_value: recurringChargeId,
    displayTarget: displayTarget,
    displayType: discountType === "126330000" ? "Flat" : "Percentage",
  };

  // 4. Decide whether to Update or Create
  if (editingDiscountId) {
    // UPDATE EXISTING RECORD
    const index = leaseDiscounts.findIndex((d) => d.id === editingDiscountId);
    if (index !== -1) {
      // Merge the existing ID with the newly edited data
      leaseDiscounts[index] = { id: editingDiscountId, ...discountData };
    }
    showNotification("Discount updated successfully", "success");
  } else {
    // CREATE NEW RECORD
    // Assign a brand new ID and push it to the array
    leaseDiscounts.push({ id: Date.now(), ...discountData });
    showNotification("Discount added successfully", "success");
  }

  // 5. Final Cleanup (Happens for both Edit and Create)
  editingDiscountId = null; // Clear the tracker
  renderDiscountsTable(); // Refresh the UI
  closeDiscountModal(); // Close the popup
}

// ============================================================================
// STAGE 4: PERSIST DISCOUNTS TO DATAVERSE  (entity: array_discount)
// Flushes the in-memory leaseDiscounts[] array on save. Missing before -> the
// discount showed in the UI but no record was ever created.
//   - Flat (126330000)       -> array_discountamount
//   - Percentage (126330001) -> array_discountpercentage
//   - Dates are DateOnly -> "YYYY-MM-DD" string is used directly (no ISO)
//   - Charge type (126330001 Specific Type) -> bind array_ChargeTypeCategory
//   - Charge type (126330002 Specific charge) -> bind array_RecurringCharge
// ============================================================================
async function createDiscounts(leaseAgreementId) {
  if (!leaseDiscounts || leaseDiscounts.length === 0) return;

  for (const disc of leaseDiscounts) {
    try {
      const isPercentage = disc.array_discounttype === 126330001;

      const payload = {
        "array_LeaseAgreement@odata.bind": `/array_leaseagreements(${leaseAgreementId})`,
        array_discounttype: disc.array_discounttype,
        array_chargetype: disc.array_chargetype,
        array_startdate: disc.array_startdate,
        array_enddate: disc.array_enddate,
      };

      // Route the entered value to the correct column
      if (isPercentage) {
        payload.array_discountpercentage = disc.array_discountpercentage;
      } else {
        payload.array_discountamount = disc.array_discountpercentage;
      }

      // Primary name so records aren't blank in views
      const leaseNm = document.getElementById("leaseName");
      payload.array_name =
        (leaseNm && leaseNm.value ? leaseNm.value : "Discount") +
        " - " +
        (isPercentage
          ? disc.array_discountpercentage + "%"
          : disc.array_discountpercentage);

      // Specific Type -> charge type category lookup
      if (
        disc.array_chargetype === 126330001 &&
        disc._array_chargetypecategory_value
      ) {
        payload["array_ChargeTypeCategory@odata.bind"] =
          `/array_chargetypes(${disc._array_chargetypecategory_value})`;
      }

      // Specific charge -> recurring charge lookup
      if (
        disc.array_chargetype === 126330002 &&
        disc._array_recurringcharge_value
      ) {
        payload["array_RecurringCharge@odata.bind"] =
          `/array_recurringcharges(${disc._array_recurringcharge_value})`;
      }

      await XrmContext.WebApi.createRecord("array_discount", payload);
    } catch (e) {
      console.error("Error creating discount:", e);
    }
  }
}

function renderDiscountsTable() {
  const tbody = document.getElementById("discountsTableBody");
  if (!tbody) return;
  tbody.innerHTML = "";
  leaseDiscounts.forEach((disc) => {
    const symbol = disc.displayType === "Percentage" ? "%" : "";
    const tr = document.createElement("tr");
    tr.innerHTML = `
            <td style="font-weight:600;color:var(--text);">${disc.displayTarget}</td>
            <td><span class="tag tag-blue">${disc.displayType}</span></td>
            <td style="font-weight:700;color:var(--blue);">${disc.array_discountpercentage}${symbol}</td>
            <td style="color:var(--hint);">${formatDateDMY(disc.array_startdate)} &ndash; ${formatDateDMY(disc.array_enddate)}</td>
            <td>
                <span class="record-actions">
                  <button class="action-edit" onclick="editDiscount(${disc.id})" title="Edit discount"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
                  <button class="action-delete" onclick="removeDiscount(${disc.id})" title="Remove discount"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg></button>
                </span>
            </td>
        `;
    tbody.appendChild(tr);
  });
}

function removeDiscount(id) {
  leaseDiscounts = leaseDiscounts.filter((d) => d.id !== id);
  renderDiscountsTable();
}

// -----------------------------------------------------------------------------
// AUTOFILL - CONDITIONAL DISCOUNTS (read-only reference panel, Stage 5)
// -----------------------------------------------------------------------------
// The document may describe trigger-based / conditional discounts that this system
// cannot model as automatic discounts. When the autofill response includes a
// `discounts` array, surface each clause here (original-language text, English
// translation, summary, affected charge, value, activation rule) so the user can
// review and, if applicable, configure a discount manually.
function renderAutofillDiscountsPanel() {
  const PANEL_ID = "autofillDiscountsPanel";
  const existing = document.getElementById(PANEL_ID);
  if (existing) existing.remove();

  const discounts = window._pendingDiscountsAutofill;
  if (!Array.isArray(discounts) || discounts.length === 0) return;

  // Anchor to the live Discount stage via the discounts table (the local HTML
  // copy is stale, so we don't rely on a fixed container id).
  const tbody = document.getElementById("discountsTableBody");
  const table = tbody ? tbody.closest("table") : null;
  const stageContent =
    (tbody && tbody.closest(".stage-content")) ||
    document.getElementById("stage4"); // Discounts = stage 4
  if (!table && !stageContent) {
    // Discount stage not in the DOM yet - will retry on the next stage change.
    console.warn(
      "Discounts panel: anchor (discountsTableBody) not found; deferring.",
    );
    return;
  }
  console.log("Discounts panel: rendering", discounts.length, "discount(s).");

  // Blue "AI summary" theme matching the app's design tokens.
  const AC = "#1C6BD4"; // accent (labels, icon, chevron) - blue
  const AC_DEEP = "#0D4A9E"; // deep text (titles, chips) - dark blue
  const AC_BORDER = "#BBDBFF"; // blue-mid border
  const AC_BG = "#EBF3FF"; // blue-l background

  // Inline SVG glyphs (ASCII-safe - avoids the file's mojibake history).
  const sparkle = (size) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${AC}" style="flex-shrink:0;"><path d="M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4z"/></svg>`;
  const chevron = () =>
    `<svg class="af-chevron" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="${AC}" stroke-width="3" style="flex-shrink:0;"><polyline points="6 9 12 15 18 9"/></svg>`;

  const field = (label, val, opts = {}) => {
    const text = _afVal(val);
    if (!text) return "";
    const pre = opts.pre ? "white-space:pre-wrap;" : "";
    return `
            <div style="margin-top:10px;">
                <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:${AC};margin-bottom:3px;">${escapeHtml(label)}</div>
                <div style="font-size:13px;color:#1f2937;line-height:1.55;${pre}">${escapeHtml(text)}</div>
            </div>`;
  };
  const collapsible = (label, val) => {
    const text = _afVal(val);
    if (!text) return "";
    // Pill-style toggle (chevron + border + hover) so it clearly reads as a
    // clickable control, not a plain label.
    return `
            <details style="margin-top:10px;">
                <summary class="af-subtoggle" style="cursor:pointer;display:inline-flex;align-items:center;gap:6px;width:fit-content;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:${AC};background:#fff;border:1px solid ${AC_BORDER};border-radius:7px;padding:6px 11px;transition:background .15s,border-color .15s;">
                    ${chevron()}<span>${escapeHtml(label)}</span>
                </summary>
                <div style="font-size:13px;color:#374151;line-height:1.6;white-space:pre-wrap;margin-top:8px;padding:10px;background:${AC_BG};border:1px solid ${AC_BORDER};border-radius:6px;">${escapeHtml(text)}</div>
            </details>`;
  };

  // One collapsible accordion item per discount (first one expanded by default).
  const items = discounts
    .map((d, i) => {
      const charge = _afVal(d.affectedCharge);
      const value = _afVal(d.discountValue);

      const chips = [];
      if (charge)
        chips.push(
          `<span style="display:inline-flex;align-items:center;gap:4px;background:${AC_BG};border:1px solid ${AC_BORDER};border-radius:999px;padding:4px 10px;font-size:12px;color:${AC_DEEP};"><b>Affected charge:</b> ${escapeHtml(charge)}</span>`,
        );
      if (value)
        chips.push(
          `<span style="display:inline-flex;align-items:center;gap:4px;background:${AC_BG};border:1px solid ${AC_BORDER};border-radius:999px;padding:4px 10px;font-size:12px;color:${AC_DEEP};"><b>Discount:</b> ${escapeHtml(value)}</span>`,
        );

      if (d._quoteUnverified)
        chips.push(
          `<span title="The original-language quote could not be matched to the document text. Check it against the PDF." style="display:inline-flex;align-items:center;gap:4px;background:#FEF6E0;border:1px solid #E3B341;border-radius:999px;padding:4px 10px;font-size:12px;color:#7a5a00;"><b>Verify quote</b></span>`,
        );

      // Title: short trigger label + value ("Proportional" for formula-based
      // reductions). The long charge description stays in the chip only.
      // Older agent output without discountLabel falls back to the charge.
      const label = _afVal(d.discountLabel);
      const titleBits = [`Discount ${i + 1}`];
      if (label) titleBits.push(escapeHtml(label));
      titleBits.push(escapeHtml(value || "Proportional"));
      if (!label && charge) titleBits.push(escapeHtml(charge));
      const title = titleBits.join(" - ");

      return `
            <details ${i === 0 ? "open" : ""} style="margin-top:10px;background:#fff;border:1px solid ${AC_BORDER};border-radius:10px;overflow:hidden;">
                <summary style="cursor:pointer;padding:12px 14px;display:flex;align-items:center;justify-content:space-between;gap:10px;background:#F0F6FF;">
                    <span style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;color:${AC_DEEP};min-width:0;">
                        ${sparkle(16)}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${title}</span>
                    </span>
                    ${chevron()}
                </summary>
                <div style="padding:14px;">
                    ${chips.length ? `<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:4px;">${chips.join("")}</div>` : ""}
                    ${field("Activation rule", d.activationRule, { pre: true })}
                    ${field("Summary", d.clauseSummary, { pre: true })}
                    ${collapsible("English text", d.englishText)}
                    ${collapsible(d._quoteFromOcr ? "Original language (exact document text)" : "Original language (unverified)", d.originalText)}
                </div>
            </details>`;
    })
    .join("");

  const n = discounts.length;
  const panel = document.createElement("div");
  panel.id = PANEL_ID;
  panel.style.marginBottom = "20px";
  panel.innerHTML = `
        <style>
            #${PANEL_ID} details > summary { list-style: none; }
            #${PANEL_ID} details > summary::-webkit-details-marker { display: none; }
            #${PANEL_ID} .af-chevron { transition: transform .2s ease; }
            #${PANEL_ID} details[open] > summary .af-chevron { transform: rotate(180deg); }
            #${PANEL_ID} .af-subtoggle:hover { background: ${AC_BG} !important; border-color: ${AC} !important; }
        </style>
        <div style="border:1px solid ${AC_BORDER};background:${AC_BG};border-radius:12px;padding:16px 18px;">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
                ${sparkle(20)}
                <h3 style="margin:0;font-size:15px;font-weight:700;color:${AC_DEEP};">
                    ${n} Conditional Discount${n !== 1 ? "s" : ""} Detected - Reference Only
                </h3>
            </div>
            <p style="margin:0;font-size:13px;color:${AC};line-height:1.5;font-style:italic;">
                The document describes conditional / trigger-based discount${n !== 1 ? "s" : ""} . Expand each to review and configure a discount manually if it applies.
            </p>
            ${items}
        </div>`;

  // Prefer placing the panel at the very top of the Discount stage (above the
  // "Added Discounts" card). Climb from the table to the block that is a direct
  // child of the stage container, and insert before it. Fall back gracefully.
  if (stageContent) {
    let block = table || tbody;
    while (
      block &&
      block.parentElement &&
      block.parentElement !== stageContent
    ) {
      block = block.parentElement;
    }
    if (block && block.parentElement === stageContent) {
      stageContent.insertBefore(panel, block);
      return;
    }
    stageContent.insertBefore(panel, stageContent.firstChild);
    return;
  }
  if (table && table.parentNode) {
    table.parentNode.insertBefore(panel, table);
  }
}

// ---- Expose global functions ----
//window.toggleWeeklyInvoiceDay = toggleWeeklyInvoiceDay;
window.DisplayAllClauseTypes = DisplayAllClauseTypes;
window.captureManualClauseData = captureManualClauseData;
window.renderOptionsGrid = renderOptionsGrid;
window.initializeOptionsModal = initializeOptionsModal;
window.saveLeaseOptions = saveLeaseOptions;
window.saveStage6Clauses = saveStage6Clauses;
window.autoPopulateNoticeDeadline = autoPopulateNoticeDeadline;
// new
window.triggerAutofillFlow = triggerAutofillFlow;
window.resolveAndSelectUnitBySuitId = resolveAndSelectUnitBySuitId;
window.resolveAndSelectUnitsByIdentifier = resolveAndSelectUnitsByIdentifier;
window.renderAutofillDiscountsPanel = renderAutofillDiscountsPanel;
window._applyOptionsAutofill = _applyOptionsAutofill;
window._applyClausesAutofill = _applyClausesAutofill;
//Dsicounts
window.toggleDiscountChargeLookups = toggleDiscountChargeLookups;
window.toggleDiscountValueType = toggleDiscountValueType;
window.addDiscount = addDiscount;
window.createDiscounts = createDiscounts;
window.removeDiscount = removeDiscount;
window.openDiscountModal = openDiscountModal;
window.closeDiscountModal = closeDiscountModal;

/* =====================================================================
 * LEASE PDF PREVIEW PANE
 * Side-by-side document preview docked into the lease wizard body.
 * Display + search: the browser's NATIVE PDF viewer (an <iframe> over a
 *   blob: URL). The viewer handles zoom, page nav, print, download AND
 *   find. Because scanned PDFs have no text layer, only the browser's
 *   built-in (OCR-backed) find can search them, so the "Find" button
 *   triggers the native viewer's search via the #search= fragment
 *   (Ctrl+F also works inside the viewer).
 * The pane is inset to the wizard body region (below the full-width
 *   header, above the action bar) so it reads as part of the page.
 * Also provides an "OCR Text" tab (placeholder until the flow returns
 *   recognized text) with its own text search.
 * Injected entirely from JS so only the JS web resource is deployed.
 * ===================================================================== */
(function () {
  "use strict";

  var WIDTH_MIN_PX = 340;
  var state = {
    name: "Document",
    buffer: null,
    blobUrl: null,
    built: false,
    insetsRaf: 0,
  };
  var els = {};

  function getZoomFactor() {
    var z = 1;
    try {
      z = parseFloat(getComputedStyle(document.body).zoom) || 1;
    } catch (e) {}
    return z > 0 ? z : 1;
  }

  /* ---------- styles ---------- */
  function injectStyles() {
    if (document.getElementById("leasePdfStyles")) return;
    var css =
      "" +
      ":root{--lpv-width:42%;--lpv-top:0px;--lpv-bottom:0px;}" +
      /* pane is sticky, fills from form-body top to above the nav; padding gives visual card spacing */
      /* docked collapsible: hidden until a doc is loaded; collapsed = thin bar, expanded = full width */
      /* z-index 8600 keeps the pane (and its edge-toggle) ABOVE the autofill
               loader overlay (z-index 8500) so the preview/toggle stay visible and
               clickable while extraction runs - esp. on small screens where the
               toggle sits at the top edge, overlapping the loader region. */
      ".lpv-pane{display:none;flex:0 0 40px;min-width:40px;background:transparent;position:relative;z-index:8600;align-self:stretch;overflow:visible;padding:0;box-sizing:border-box;transition:flex-basis .18s ease;}" +
      "body.lpv-has-doc .lpv-pane{display:flex;}" +
      "body.lpv-open .lpv-pane{flex:0 0 var(--lpv-width);min-width:" +
      WIDTH_MIN_PX +
      "px;}" +
      /* form-body becomes a full-width flex row whenever a doc is present (collapsed or open) */
      "body.lpv-has-doc .form-body{display:flex;flex-direction:row;align-items:stretch;width:100%!important;max-width:none!important;margin:0!important;padding:0!important;}" +
      /* left column wraps all stage content */
      ".lpv-form-col{flex:1 1 0;min-width:0;overflow-y:auto;padding:32px 16px 96px 24px;}" +
      /* resizer lives inside the pane - moves with it on drag */
      ".lpv-resizer{position:absolute;left:0;top:0;bottom:0;width:16px;cursor:col-resize;z-index:5;}" +
      ".lpv-resizer{cursor:col-resize;}" +
      "body.lpv-dragging .lpv-pane,body.lpv-dragging .lpv-form-col{transition:none!important;}" +
      /* while dragging, stop the iframe (and any element) from swallowing mousemove so the resize follows the cursor right INTO the pdf */
      "body.lpv-dragging{user-select:none;cursor:col-resize;}" +
      "body.lpv-dragging .lpv-frame,body.lpv-dragging iframe{pointer-events:none!important;}" +
      /* inner card fills the pane (minus padding); matches section-content card style */
      ".lpv-inner{flex:1;display:none;flex-direction:column;min-width:0;background:#fff;border-radius:0;border:none;border-left:1px solid rgba(0,0,0,0.08);box-shadow:none;overflow:hidden;}" +
      "body.lpv-open .lpv-inner{display:flex;}" +
      ".lpv-file{display:flex;align-items:center;gap:6px;min-width:0;flex:1 1 auto;}" +
      ".lpv-fileicon{color:#B91C1C;display:flex;flex-shrink:0;}" +
      ".lpv-filename{font-size:12px;font-weight:700;color:#111827;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;min-width:0;}" +
      ".lpv-toolbar{display:flex;flex-direction:column;gap:0;background:#FAFBFC;border-bottom:1px solid rgba(0,0,0,0.08);padding:0;flex-shrink:0;}" +
      ".lpv-toolbar .lpv-row{padding:9px 11px;}" +
      ".lpv-toolbar .lpv-row+.lpv-row{border-top:1px solid rgba(0,0,0,0.08);}" +
      ".lpv-row{display:flex;align-items:center;gap:8px;}" +
      ".lpv-tabs{display:inline-flex;background:#EEF1F6;border-radius:8px;padding:3px;flex-shrink:0;}" +
      ".lpv-tab{background:transparent;color:#4B5563;border:none;padding:6px 14px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;transition:all .15s;}" +
      ".lpv-tab:hover{color:#111827;}" +
      ".lpv-tab.active{background:#fff;color:#1C6BD4;box-shadow:0 1px 3px rgba(15,23,42,.12);}" +
      ".lpv-spacer{flex:0 0 0;}" +
      ".lpv-ic{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;background:transparent;border:none;color:#4B5563;cursor:pointer;border-radius:6px;transition:background .15s,color .15s;flex-shrink:0;}" +
      ".lpv-ic:hover{background:#EBF3FF;color:#1C6BD4;}" +
      ".lpv-ic-close:hover{background:#FEF2F2;color:#B91C1C;}" +
      ".lpv-body{flex:1;position:relative;overflow:hidden;background:#F3F5F9;}" +
      ".lpv-frame{position:absolute;inset:0;width:100%;height:100%;border:0;background:#F3F5F9;color-scheme:light;}" +
      ".lpv-empty,.lpv-error{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;color:#605e5c;font-size:14px;padding:24px;flex-direction:column;gap:12px;}" +
      ".lpv-empty svg,.lpv-error svg{opacity:.7;}" +
      ".lpv-error{color:#B91C1C;background:#FEF2F2;}" +
      ".lpv-view-ocr{position:absolute;inset:0;display:flex;flex-direction:column;background:#fff;}" +
      ".lpv-ocr-search{position:relative;padding:10px 12px;border-bottom:1px solid rgba(0,0,0,0.08);background:#FAFBFC;}" +
      ".lpv-ocr-search-ic{position:absolute;left:23px;top:50%;transform:translateY(-50%);color:#9CA3AF;display:flex;pointer-events:none;}" +
      ".lpv-ocr-search input{width:100%;border:1px solid rgba(0,0,0,0.14);border-radius:8px;padding:8px 12px 8px 34px;font-size:13px;outline:none;background:#fff;}" +
      ".lpv-ocr-search input:focus{border-color:#1C6BD4;box-shadow:0 0 0 3px #EBF3FF;}" +
      ".lpv-ocr-text{flex:1;overflow:auto;margin:0;padding:18px 20px;font-family:'Segoe UI',sans-serif;font-size:13px;line-height:1.75;color:#1e293b;white-space:pre-wrap;word-break:break-word;}" +
      ".lpv-ocr-text mark{background:#fde68a;color:inherit;border-radius:2px;padding:0 1px;}" +
      ".lpv-ocr-placeholder{color:#94a3b8;font-style:italic;}" +
      /* collapsed thin bar (shown when docked but not open) */
      ".lpv-collapsed{flex:1;display:flex;align-items:center;justify-content:center;background:#fff;border:none;border-left:1px solid rgba(0,0,0,0.08);border-radius:0;cursor:pointer;transition:background .15s;}" +
      ".lpv-collapsed:hover{background:#FAFBFC;}" +
      ".lpv-collapsed span{writing-mode:vertical-rl;text-orientation:mixed;transform:rotate(180deg);font-size:11px;font-weight:700;letter-spacing:.6px;color:#9CA3AF;text-transform:uppercase;}" +
      "body.lpv-open .lpv-collapsed{display:none;}" +
      /* circular edge chevron toggle on the pane's left edge */
      ".lpv-edge-toggle{position:absolute;left:-13px;top:50%;transform:translateY(-50%);width:26px;height:26px;border-radius:50%;background:#fff;border:1.5px solid rgba(0,0,0,0.14);display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:25;color:#4B5563;box-shadow:0 2px 6px rgba(0,0,0,0.1);transition:color .15s,border-color .15s;}" +
      ".lpv-edge-toggle:hover{color:#1C6BD4;border-color:#BBDBFF;}" +
      ".lpv-edge-toggle svg{transition:transform .18s ease;}" +
      "body.lpv-open .lpv-edge-toggle svg{transform:rotate(180deg);}" +
      // narrow screens: pane docks to the BOTTOM as a horizontal bar
      // (no inline /* */ comments between the + concatenations - a bare
      //  `+ /* */ "str"` coerces the string via unary plus -> NaN in CSS).
      "@media (max-width:900px){" +
      "body.lpv-has-doc .form-body{flex-direction:column;}" +
      "body.lpv-has-doc .lpv-pane{align-self:stretch;width:100%!important;}" +
      "body.lpv-has-doc:not(.lpv-open) .lpv-pane{flex:0 0 46px!important;min-width:0!important;min-height:46px;}" +
      "body.lpv-open .lpv-pane{min-width:100%!important;width:100%!important;position:relative;top:auto;flex:0 0 62vh!important;height:62vh;}" +
      ".lpv-collapsed{border-left:none;border-top:1px solid rgba(0,0,0,0.08);}" +
      ".lpv-collapsed span{writing-mode:horizontal-tb!important;text-orientation:initial!important;transform:none!important;}" +
      ".lpv-inner{border-left:none;border-top:1px solid rgba(0,0,0,0.08);}" +
      ".lpv-resizer{display:none;}" +
      ".lpv-edge-toggle{left:50%!important;top:-13px!important;transform:translateX(-50%)!important;}" +
      ".lpv-edge-toggle svg{transform:rotate(90deg);}" +
      "body.lpv-open .lpv-edge-toggle svg{transform:rotate(-90deg);}" +
      "}";
    var st = document.createElement("style");
    st.id = "leasePdfStyles";
    st.textContent = css;
    document.head.appendChild(st);
  }

  /* ---------- small svg helpers ---------- */
  function svg(path, size) {
    size = size || 16;
    return (
      '<svg width="' +
      size +
      '" height="' +
      size +
      '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      path +
      "</svg>"
    );
  }
  var IC = {
    doc: '<path d="M14 3v5h5M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    open: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    dl: '<path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  };

  /* ---------- DOM build ---------- */
  function ensureDom() {
    if (state.built) return;
    injectStyles();

    var pane = document.createElement("div");
    pane.className = "lpv-pane";
    pane.id = "leasePdfPane";
    pane.innerHTML =
      '<button class="lpv-edge-toggle" id="leasePdfEdgeToggle" title="Expand / collapse preview">' +
      svg('<path d="M15 18l-6-6 6-6"/>', 14) +
      "</button>" +
      '<div class="lpv-collapsed" id="leasePdfCollapsed" title="Expand document preview"><span>PDF Preview</span></div>' +
      '<div class="lpv-resizer" id="leasePdfResizer"></div>' +
      '<div class="lpv-inner">' +
      '<div class="lpv-toolbar">' +
      '<div class="lpv-row">' +
      '<div class="lpv-file"><span class="lpv-fileicon">' +
      svg(IC.doc, 14) +
      '</span><span class="lpv-filename" id="leasePdfName">Document preview</span></div>' +
      '<div class="lpv-spacer"></div>' +
      '<div class="lpv-tabs"><button class="lpv-tab active" data-tab="pdf">Document</button><button class="lpv-tab" data-tab="ocr">OCR</button></div>' +
      '<button class="lpv-ic" id="leasePdfOpen" title="Open in new tab">' +
      svg(IC.open, 16) +
      "</button>" +
      '<button class="lpv-ic" id="leasePdfDownload" title="Download">' +
      svg(IC.dl, 16) +
      "</button>" +
      "</div>" +
      "</div>" +
      '<div class="lpv-body">' +
      '<iframe class="lpv-frame" id="leasePdfFrame" title="PDF preview" style="display:none"></iframe>' +
      '<div class="lpv-empty" id="leasePdfEmpty">' +
      svg(IC.doc, 30) +
      "<div>Upload a PDF to preview it here.</div></div>" +
      '<div class="lpv-error" id="leasePdfError" style="display:none"></div>' +
      '<div class="lpv-view-ocr" id="leasePdfOcr" style="display:none">' +
      '<div class="lpv-ocr-search"><span class="lpv-ocr-search-ic">' +
      svg(IC.search, 15) +
      '</span><input type="text" id="leaseOcrSearch" placeholder="Search OCR text..."></div>' +
      '<div class="lpv-ocr-text" id="leasePdfOcrText"><span class="lpv-ocr-placeholder">OCR text is not available yet. Once the extraction flow returns recognized text, it will appear here.</span></div>' +
      "</div>" +
      "</div>" +
      "</div>";

    // Mount the pane inside form-body so it sits in-flow beside the form content.
    // Wrap all existing form-body children in a scrollable column first.
    var formBody = document.getElementById("formBody");
    if (formBody && !document.getElementById("lpvFormCol")) {
      var col = document.createElement("div");
      col.className = "lpv-form-col";
      col.id = "lpvFormCol";
      while (formBody.firstChild) col.appendChild(formBody.firstChild);
      formBody.appendChild(col);
    }
    if (formBody) {
      formBody.appendChild(pane);
    } else {
      document.body.appendChild(pane);
    }

    cacheEls();
    wireEvents();

    window.addEventListener("resize", scheduleInsets);
    scheduleInsets();

    state.built = true;
  }

  function cacheEls() {
    var ids = [
      "leasePdfPane",
      "leasePdfResizer",
      "leasePdfOpen",
      "leasePdfDownload",
      "leasePdfClose",
      "leasePdfTools",
      "leasePdfFindBtn",
      "leasePdfName",
      "leasePdfFrame",
      "leasePdfEmpty",
      "leasePdfError",
      "leasePdfOcr",
      "leasePdfOcrText",
      "leaseOcrSearch",
      "leasePdfEdgeToggle",
      "leasePdfCollapsed",
    ];
    ids.forEach(function (id) {
      els[id] = document.getElementById(id);
    });
  }

  /* ---------- body-region insets ---------- */
  function updateInsets() {
    var de = document.documentElement;
    var z = getZoomFactor();
    // Measure fixed-layout elements above form-body so --lpv-top never
    // changes on scroll, keeping pane and form-col heights stable.
    var header = document.querySelector(".form-header");
    var stepper = document.querySelector(".stage-progress");
    var nav = document.querySelector(".stage-navigation");
    var top = 0,
      bottom = 0;
    if (header) top += header.offsetHeight;
    if (stepper) top += stepper.offsetHeight;
    if (nav) bottom = nav.offsetHeight;
    de.style.setProperty("--lpv-top", top / z + "px");
    de.style.setProperty("--lpv-bottom", bottom / z + "px");
  }
  function scheduleInsets() {
    if (state.insetsRaf) return;
    state.insetsRaf = requestAnimationFrame(function () {
      state.insetsRaf = 0;
      updateInsets();
    });
  }

  /* ---------- panel show/hide ---------- */
  function openPanel() {
    ensureDom();
    document.body.classList.add("lpv-open");
    scheduleInsets();
  }
  function closePanel() {
    document.body.classList.remove("lpv-open");
  }

  // Fully clear the loaded document (used by the form Reset). Unlike close(),
  // this revokes the blob, blanks the iframe, drops the OCR text, and returns
  // the pane to its empty state so no stale PDF survives a reset.
  function unload() {
    if (state.blobUrl) {
      try {
        URL.revokeObjectURL(state.blobUrl);
      } catch (e) {}
    }
    state.blobUrl = null;
    state.buffer = null;
    state.name = "Document";
    document.body.classList.remove("lpv-open", "lpv-has-doc");
    if (els.leasePdfFrame) els.leasePdfFrame.src = "about:blank";
    if (els.leasePdfName) els.leasePdfName.textContent = "Document";
    if (els.leasePdfSearch) els.leasePdfSearch.value = "";
    showError("");
    setOcrText("");
    showEmpty(true);
  }
  function togglePanel() {
    document.body.classList.contains("lpv-open") ? closePanel() : openPanel();
  }

  function switchTab(tab) {
    els.leasePdfPane.querySelectorAll(".lpv-tab").forEach(function (t) {
      t.classList.toggle("active", t.getAttribute("data-tab") === tab);
    });
    var isPdf = tab === "pdf";
    var hasDoc = !!state.blobUrl;
    if (els.leasePdfTools)
      els.leasePdfTools.style.display = isPdf ? "" : "none";
    els.leasePdfFrame.style.display = isPdf && hasDoc ? "block" : "none";
    els.leasePdfEmpty.style.display = isPdf && !hasDoc ? "flex" : "none";
    els.leasePdfOcr.style.display = isPdf ? "none" : "flex";
  }

  /* ---------- state helpers ---------- */
  function showEmpty(on) {
    if (els.leasePdfEmpty)
      els.leasePdfEmpty.style.display = on ? "flex" : "none";
  }
  function showError(msg) {
    if (!els.leasePdfError) return;
    els.leasePdfError.style.display = msg ? "flex" : "none";
    els.leasePdfError.innerHTML = msg
      ? svg(IC.doc, 28) + "<div>" + escapeForHtml(msg) + "</div>"
      : "";
  }
  function escapeForHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  /* ---------- load (native iframe viewer) ---------- */
  function load(buffer, name) {
    ensureDom();
    document.body.classList.add("lpv-has-doc");
    state.name = name || "Document";
    state.buffer = buffer;
    openPanel();
    showError("");
    if (els.leasePdfSearch) els.leasePdfSearch.value = "";

    if (els.leasePdfName) els.leasePdfName.textContent = state.name;
    if (state.blobUrl) {
      try {
        URL.revokeObjectURL(state.blobUrl);
      } catch (e) {}
    }
    try {
      state.blobUrl = URL.createObjectURL(
        new Blob([buffer], { type: "application/pdf" }),
      );
      // Keep the browser's full native PDF viewer chrome (toolbar, page
      // navigation, zoom, thumbnail/side panel). #view=FitH just sets the
      // initial fit; it does NOT hide any controls.
      els.leasePdfFrame.src = state.blobUrl + "#view=FitH";
      showEmpty(false);
    } catch (e) {
      state.blobUrl = null;
      showError("Could not display this PDF.");
    }
    switchTab("pdf");
  }

  /* ---------- native find (delegates to the browser PDF viewer) ---------- */
  function nativeFind(term) {
    if (!state.blobUrl) return;
    var q = (term || "").trim();
    var frame = els.leasePdfFrame;
    // Re-point the iframe at the same document with a #search fragment so
    // the native viewer runs its own (OCR-backed) find. Ctrl+F inside the
    // viewer remains available too.
    frame.src =
      state.blobUrl + (q ? "#search=" + encodeURIComponent(q) : "#view=FitH");
    try {
      frame.focus();
    } catch (e) {}
  }

  /* ---------- OCR tab ---------- */
  function setOcrText(text) {
    ensureDom();
    var box = els.leasePdfOcrText;
    if (!box) return;
    if (text == null || String(text).trim() === "") {
      box.innerHTML =
        '<span class="lpv-ocr-placeholder">OCR text is not available yet. Once the extraction flow returns recognized text, it will appear here.</span>';
      box.setAttribute("data-raw", "");
      return;
    }
    box.setAttribute("data-raw", String(text));
    box.textContent = String(text);
  }
  function runOcrSearch(q) {
    var box = els.leasePdfOcrText;
    var raw = box ? box.getAttribute("data-raw") : "";
    if (!raw) return;
    var query = (q || "").trim();
    if (!query) {
      box.textContent = raw;
      return;
    }
    var esc = escapeForHtml(raw);
    var safe = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    box.innerHTML = esc.replace(new RegExp(safe, "gi"), function (m) {
      return "<mark>" + m + "</mark>";
    });
    var first = box.querySelector("mark");
    if (first) first.scrollIntoView({ block: "center" });
  }

  /* ---------- open / download ---------- */
  function openInNewTab() {
    if (state.blobUrl) window.open(state.blobUrl, "_blank");
  }
  function downloadPdf() {
    if (!state.blobUrl) return;
    var a = document.createElement("a");
    a.href = state.blobUrl;
    a.download =
      state.name && /\.pdf$/i.test(state.name)
        ? state.name
        : (state.name || "document") + ".pdf";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  /* ---------- resizing ---------- */
  function startResize(e) {
    e.preventDefault();
    document.body.classList.add("lpv-dragging");
    var z = getZoomFactor();
    function onMove(ev) {
      var clientX = ev.touches ? ev.touches[0].clientX : ev.clientX;
      var fb = document.getElementById("formBody");
      var fbRect = fb
        ? fb.getBoundingClientRect()
        : { left: 0, width: window.innerWidth };
      var px = (fbRect.left + fbRect.width - clientX) / z;
      var maxPx = (fbRect.width * 0.75) / z;
      px = Math.max(WIDTH_MIN_PX, Math.min(px, maxPx));
      document.documentElement.style.setProperty("--lpv-width", px + "px");
    }
    function onUp() {
      document.body.classList.remove("lpv-dragging");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onUp);
  }

  /* ---------- events ---------- */
  function debounce(fn, ms) {
    var t = 0;
    return function () {
      var a = arguments,
        c = this;
      clearTimeout(t);
      t = setTimeout(function () {
        fn.apply(c, a);
      }, ms);
    };
  }
  function wireEvents() {
    if (els.leasePdfClose) els.leasePdfClose.onclick = closePanel;
    if (els.leasePdfEdgeToggle) els.leasePdfEdgeToggle.onclick = togglePanel;
    if (els.leasePdfCollapsed) els.leasePdfCollapsed.onclick = openPanel;
    if (els.leasePdfOpen) els.leasePdfOpen.onclick = openInNewTab;
    if (els.leasePdfDownload) els.leasePdfDownload.onclick = downloadPdf;
    els.leasePdfResizer.addEventListener("mousedown", startResize);
    els.leasePdfResizer.addEventListener("touchstart", startResize, {
      passive: false,
    });

    els.leasePdfPane.querySelectorAll(".lpv-tab").forEach(function (t) {
      t.onclick = function () {
        switchTab(t.getAttribute("data-tab"));
      };
    });

    // (find-in-document button and OCR search input were removed to match the new minimal design)
    if (els.leaseOcrSearch) {
      els.leaseOcrSearch.addEventListener(
        "input",
        debounce(function () {
          runOcrSearch(els.leaseOcrSearch.value);
        }, 220),
      );
    }
  }

  /* ---------- public API ---------- */
  window.LeasePdfPreview = {
    load: load,
    open: openPanel,
    close: closePanel,
    unload: unload,
    toggle: togglePanel,
    setOcrText: setOcrText,
  };
  window.setLeasePdfOcrText = setOcrText;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ensureDom);
  } else {
    ensureDom();
  }
})();