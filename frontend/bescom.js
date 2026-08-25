if (!localStorage.getItem("role") || !localStorage.getItem("token")) {
  window.location.href = "login.html";
}
let role = localStorage.getItem("role");
let isAdmin = String(role).toLowerCase() === "admin";

function logout() {
  localStorage.removeItem("token");
  localStorage.removeItem("role");
  localStorage.removeItem("userEmail");
  window.location.href = "login.html";
}

document.addEventListener("DOMContentLoaded", () => {
  const el = document.getElementById("loggedInUser");
  const email = localStorage.getItem("userEmail");
  if (el && email) el.textContent = email;
});

// If the backend ever rejects our token (expired, or an old token issued
// for a different account before this restriction existed), send the user
// back to login instead of leaving them on a broken page. Wrapping the
// global fetch means every existing and future API call in this file gets
// this behavior automatically, without needing to touch each call site.
const _nativeFetch = window.fetch.bind(window);
window.fetch = async function (input, init) {
  const response = await _nativeFetch(input, init);
  const url = typeof input === "string" ? input : input && input.url;
  if ((response.status === 401 || response.status === 403) && url && url.includes(API_URL)) {
    let message = "Access denied. This inventory system is restricted to authorized users.";
    try {
      const body = await response.clone().json();
      if (body && body.message) message = body.message;
    } catch (e) {
      // ignore
    }
    localStorage.removeItem("token");
    localStorage.removeItem("role");
    localStorage.removeItem("userEmail");
    alert(message);
    window.location.href = "login.html";
  }
  return response;
};

let bescomComponents = [];
let editingComponentId = null;

function authHeaders() {
  return {
    "Content-Type": "application/json",
    Authorization: "Bearer " + (localStorage.getItem("token") || ""),
  };
}

function showBescomError(message) {
  const el = document.getElementById("bescomError");
  if (!message) {
    el.style.display = "none";
    el.innerText = "";
    return;
  }
  el.innerText = message;
  el.style.display = "block";
}

function qtyClass(available) {
  if (available <= 0) return "bescom-qty-none";
  if (available <= 3) return "bescom-qty-low";
  return "bescom-qty-available";
}

/* ---------------- Summary ---------------- */
async function loadBescomSummary() {
  const container = document.getElementById("bescomSummary");

  if (!container) {
    console.error("BESCOM summary container not found");
    return;
  }

  try {
    // Get the actual component records
    const response = await fetch(`${API_URL}/bescom/components`, {
      method: "GET",
      headers: authHeaders(),
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`Failed to load components: HTTP ${response.status}`);
    }

    const data = await response.json();

    console.log("BESCOM components used for summary:", data);

    if (!data.success || !Array.isArray(data.components)) {
      throw new Error(data.message || "Invalid component data");
    }

    const components = data.components;

    // Calculate everything directly from the actual component data
    const totalComponents = components.length;

    const totalStock = components.reduce(
      (sum, component) =>
        sum + Number(component.totalQuantity || 0),
      0
    );

    const availableStock = components.reduce(
      (sum, component) =>
        sum + Number(component.availableQuantity || 0),
      0
    );

    const damagedQuantity = components.reduce(
      (sum, component) =>
        sum + Number(component.damagedQuantity || 0),
      0
    );

    console.log("BESCOM SUMMARY CALCULATED:", {
      totalComponents,
      totalStock,
      availableStock,
      damagedQuantity
    });

    container.innerHTML = `
      <div class="card">
        <h3>Total Components</h3>
        <p>${totalComponents.toLocaleString()}</p>
      </div>

      <div class="card">
        <h3>Total Stock</h3>
        <p>${totalStock.toLocaleString()}</p>
      </div>

      <div class="card">
        <h3>Available Stock</h3>
        <p>${availableStock.toLocaleString()}</p>
      </div>

      <div class="card">
        <h3>Damaged Quantity</h3>
        <p>${damagedQuantity.toLocaleString()}</p>
      </div>
    `;

  } catch (error) {
    console.error("❌ Failed to calculate BESCOM summary:", error);

    container.innerHTML = `
      <div class="card">
        <h3>Total Components</h3>
        <p>—</p>
      </div>

      <div class="card">
        <h3>Total Stock</h3>
        <p>—</p>
      </div>

      <div class="card">
        <h3>Available Stock</h3>
        <p>—</p>
      </div>

      <div class="card">
        <h3>Damaged Quantity</h3>
        <p>—</p>
      </div>
    `;

    console.error(error);
  }
}
/* ---------------- Components ---------------- */
async function loadBescomComponents(search, category) {
  const container = document.getElementById("bescomComponentsContainer");
  container.innerHTML = "Loading...";
  try {
    const url = new URL(`${API_URL}/bescom/components`);
    if (search) url.searchParams.set("search", search);
    if (category) url.searchParams.set("category", category);
    const res = await fetch(url, { headers: authHeaders() });
    const data = await res.json();
    if (!data.success) {
      container.innerHTML = `<p>Could not load components: ${data.message || "unknown error"}</p>`;
      return;
    }
    bescomComponents = data.components;
    renderBescomComponents();
    populateCategoryFilter();
  } catch (err) {
    console.error("Failed to load BESCOM components", err);
    container.innerHTML = "<p>Could not load components.</p>";
  }
}

function populateCategoryFilter() {
  const select = document.getElementById("componentCategoryFilter");
  const current = select.value;
  const categories = [...new Set(bescomComponents.map((c) => c.category).filter(Boolean))].sort();
  select.innerHTML =
    `<option value="">All categories</option>` +
    categories.map((cat) => `<option value="${cat}">${cat}</option>`).join("");
  select.value = current;
}

function renderBescomComponents() {
  const container = document.getElementById("bescomComponentsContainer");
  if (bescomComponents.length === 0) {
    container.innerHTML = `<div class="bescom-empty">No BESCOM components available</div>`;
    return;
  }

  let rows = bescomComponents
    .map((c) => {
      const damageReason = c.damageReason || "-";
      const safeName = String(c.name || "").replace(/"/g, "&quot;");

      return `
        <tr>
          <td>${c.name}</td>
          <td>${c.serialNumber}</td>
          <td>${c.totalQuantity}</td>
          <td class="${qtyClass(c.availableQuantity)}">${c.availableQuantity}</td>
          <td>${c.damagedQuantity}</td>
          <td>${damageReason}</td>
          <td><span class="bescom-status ${c.status}">${c.status}</span></td>
          <td class="bescom-actions">
            ${
              isAdmin
                ? `<button onclick="openEditComponentModal(${c.componentId})">Edit</button>
                   <button class="btn-danger" onclick="deleteComponent(${c.componentId}, &quot;${safeName}&quot;)">🗑 Delete</button>`
                : ""
            }
          </td>
        </tr>
      `;
    })
    .join("");

  container.innerHTML = `
    <table class="bescom-table">
      <thead>
        <tr>
          <th>Component Name</th>
          <th>Serial Number</th>
          <th>Total Stock</th>
          <th>Available Stock</th>
          <th>Damaged Quantity</th>
          <th>Damage Reason</th>
          <th>Status</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

let componentSearchTimer = null;
function onComponentSearch() {
  clearTimeout(componentSearchTimer);
  const value = document.getElementById("componentSearch").value.trim();
  const category = document.getElementById("componentCategoryFilter").value;
  componentSearchTimer = setTimeout(() => loadBescomComponents(value, category), 250);
}

/* ---------- Add / Edit Component form ---------- */
function openAddComponentModal() {
  editingComponentId = null;
  document.getElementById("componentModalTitle").innerText = "Add Component";
  document.getElementById("componentFormSerialRow").style.display = "none";
  document.getElementById("componentFormCode").value = "";
  document.getElementById("componentFormCode").disabled = false;
  document.getElementById("componentFormName").value = "";
  document.getElementById("componentFormCategory").value = "";
  document.getElementById("componentFormQuantity").value = "";
  document.getElementById("componentFormDamaged").value = "";
  document.getElementById("componentFormDamageReason").value = "";
  document.getElementById("componentFormDamageDescription").value = "";
  document.getElementById("componentFormNotes").value = "";
  document.getElementById("componentFormDescription").value = "";
  document.getElementById("componentFormStatusLabel").style.display = "none";
  document.getElementById("componentFormStatus").style.display = "none";
  document.getElementById("componentFormError").style.display = "none";
  document.getElementById("componentModal").style.display = "flex";
}

function openEditComponentModal(componentId) {
  const component = bescomComponents.find((c) => c.componentId === componentId);
  if (!component) return;

  editingComponentId = componentId;
  document.getElementById("componentModalTitle").innerText = "Edit Component";
  // Serial Number is system-generated and never editable -- shown for
  // reference only, and stays fixed across edits (requirement: editing a
  // component must not generate or change its Serial Number).
  document.getElementById("componentFormSerialRow").style.display = "block";
  document.getElementById("componentFormSerial").value = component.serialNumber;
  document.getElementById("componentFormCode").value = component.componentCode;
  document.getElementById("componentFormCode").disabled = true;
  document.getElementById("componentFormName").value = component.name;
  document.getElementById("componentFormCategory").value = component.category || "";
  document.getElementById("componentFormQuantity").value = component.totalQuantity;
  document.getElementById("componentFormDamaged").value = component.damagedQuantity || "";
  document.getElementById("componentFormDamageReason").value = component.damageReason || "";
  document.getElementById("componentFormDamageDescription").value = component.damageDescription || "";
  document.getElementById("componentFormNotes").value = component.notes || "";
  document.getElementById("componentFormDescription").value = component.description || "";
  document.getElementById("componentFormStatusLabel").style.display = "block";
  document.getElementById("componentFormStatus").style.display = "block";
  document.getElementById("componentFormStatus").value = component.status;
  document.getElementById("componentFormError").style.display = "none";
  document.getElementById("componentModal").style.display = "flex";
}

function closeComponentModal() {
  document.getElementById("componentModal").style.display = "none";
}

async function submitComponentForm() {
  const componentCode = document.getElementById("componentFormCode").value.trim();
  const name = document.getElementById("componentFormName").value.trim();
  const category = document.getElementById("componentFormCategory").value.trim();
  const quantity = document.getElementById("componentFormQuantity").value;
  const damagedQuantity = document.getElementById("componentFormDamaged").value;
  const damageReason = document.getElementById("componentFormDamageReason").value.trim();
  const damageDescription = document.getElementById("componentFormDamageDescription").value.trim();
  const notes = document.getElementById("componentFormNotes").value.trim();
  const description = document.getElementById("componentFormDescription").value.trim();
  const status = document.getElementById("componentFormStatus").value;
  const errorEl = document.getElementById("componentFormError");
  errorEl.style.display = "none";

  // Every field is optional -- the user can save a record with just one
  // piece of information filled in. Only reject values that are actually
  // invalid (e.g. a negative number), never a blank field.
  if (quantity !== "" && (!Number.isFinite(Number(quantity)) || Number(quantity) < 0)) {
    errorEl.innerText = "Stock must be a non-negative number";
    errorEl.style.display = "block";
    return;
  }
  if (damagedQuantity !== "" && (!Number.isFinite(Number(damagedQuantity)) || Number(damagedQuantity) < 0)) {
    errorEl.innerText = "Damaged quantity must be a non-negative number";
    errorEl.style.display = "block";
    return;
  }
  if (
    quantity !== "" &&
    damagedQuantity !== "" &&
    Number(damagedQuantity) > Number(quantity)
  ) {
    errorEl.innerText = "Damaged quantity cannot exceed total stock";
    errorEl.style.display = "block";
    return;
  }
  if (
    !editingComponentId &&
    !componentCode &&
    !name &&
    quantity === "" &&
    damagedQuantity === "" &&
    !damageReason &&
    !damageDescription &&
    !notes &&
    !description
  ) {
    errorEl.innerText = "Enter at least one piece of information";
    errorEl.style.display = "block";
    return;
  }

  const payload = {
    componentCode,
    name,
    category,
    quantity: quantity === "" ? undefined : Number(quantity),
    damagedQuantity: damagedQuantity === "" ? undefined : Number(damagedQuantity),
    damageReason,
    damageDescription,
    notes,
    description,
    status,
  };

  try {
    let res;
    if (editingComponentId) {
      res = await fetch(`${API_URL}/bescom/components/${editingComponentId}`, {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify(payload),
      });
    } else {
      res = await fetch(`${API_URL}/bescom/components`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(payload),
      });
    }
    const data = await res.json();
    if (!data.success) {
      errorEl.innerText = data.message || "Failed to save component";
      errorEl.style.display = "block";
      return;
    }

    closeComponentModal();
    alert(editingComponentId ? "Component updated successfully" : "Component added successfully");
    const currentSearch = document.getElementById("componentSearch").value.trim();
    const currentCategory = document.getElementById("componentCategoryFilter").value;
    loadBescomComponents(currentSearch, currentCategory);
    loadBescomSummary();
  } catch (err) {
    console.error("Failed to save component", err);
    errorEl.innerText = "Server error while saving component";
    errorEl.style.display = "block";
  }
}

/* ---------------- Delete Component ---------------- */
async function deleteComponent(componentId, name) {
  const label = name ? `"${name}"` : "this component";
  const confirmed = confirm(
    `Are you sure you want to delete ${label}?\n\nThis action cannot be undone.`,
  );
  if (!confirmed) return;

  try {
    const res = await fetch(`${API_URL}/bescom/components/${componentId}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    const data = await res.json();
    if (!data.success) {
      alert(data.message || "Failed to delete component");
      return;
    }

    alert(data.message || "Component deleted successfully");
    // Reload from the backend rather than just splicing the array, so the
    // table reflects the actual database state -- but keep whatever
    // search/category filter the user currently has active instead of
    // silently resetting it back to the full list.
    const currentSearch = document.getElementById("componentSearch").value.trim();
    const currentCategory = document.getElementById("componentCategoryFilter").value;
    loadBescomComponents(currentSearch, currentCategory);
    loadBescomSummary();
  } catch (err) {
    console.error("Failed to delete component", err);
    alert("Server error while deleting component");
  }
}

/* ---------------- Init ---------------- */
function initBescomPage() {
  if (isAdmin) {
    document.getElementById("addComponentBtn").style.display = "inline-block";
  }
  loadBescomSummary();
  loadBescomComponents();
}

initBescomPage();

/* =========================================================
   BESCOM COMPONENT REPORT DOWNLOAD
   ========================================================= */

async function downloadBescomReport() {
  const statusEl = document.getElementById("bescomReportStatus");

  try {
    if (statusEl) {
      statusEl.style.display = "block";
      statusEl.innerText = "Generating report... Please wait.";
    }

    const endpoint = `${API_URL}/bescom/reports/pdf`;

    const response = await fetch(endpoint, {
      method: "GET",
      headers: authHeaders(),
    });

    if (!response.ok) {
      let errorMessage = "Failed to generate report.";

      try {
        const errorData = await response.json();
        if (errorData.message) {
          errorMessage = errorData.message;
        }
      } catch (_) {
        // Response was not JSON
      }

      throw new Error(errorMessage);
    }

    const blob = await response.blob();

    if (!blob || blob.size === 0) {
      throw new Error("The generated report is empty.");
    }

    const today = new Date().toISOString().slice(0, 10);
    const fileName = `BESCOM_Component_Inventory_Report_${today}.pdf`;

    const downloadUrl = window.URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = downloadUrl;
    link.download = fileName;

    document.body.appendChild(link);
    link.click();
    link.remove();

    window.URL.revokeObjectURL(downloadUrl);

    if (statusEl) {
      statusEl.innerText = "Report downloaded successfully.";
      setTimeout(() => {
        statusEl.style.display = "none";
      }, 3000);
    }
  } catch (error) {
    console.error("BESCOM report download failed:", error);
    if (statusEl) {
      statusEl.style.display = "block";
      statusEl.innerText = error.message || "Unable to download the report.";
    } else {
      alert(error.message || "Unable to download the report.");
    }
  }
}
