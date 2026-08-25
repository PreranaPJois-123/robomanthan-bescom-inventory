const express = require("express");
require("dotenv").config();

const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET;

const app = express();
const cors = require("cors");
const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");
const { logAudit } = require("./audit");
const pdfTheme = require("./pdfTheme");

app.use(express.json());
app.use(cors());

// ===========================================================================
// SINGLE-TENANT, SINGLE-USER ACCESS CONTROL
//
// This application has been converted into a BESCOM-only inventory system.
// BESCOM is the only inventory/organization in the app, and
// saurav@robomanthan.com is the only account permitted to use it.
//
// The allowed email is intentionally a hard-coded constant (not an env var)
// so the restriction cannot be silently widened by a configuration change.
// It is enforced in `authenticateToken` below, which runs on every
// protected route -- so this is not just a login-time / UI-level check.
// ===========================================================================
const ALLOWED_ADMIN_EMAIL = "saurav@robomanthan.com";

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  ssl: {
    rejectUnauthorized: false,
  },
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 20000,
  max: 10,
});

// Without this, an idle client that gets reset by Neon (e.g. after its
// compute auto-suspends and wakes back up) throws an unhandled 'error'
// event at the process level and can crash the whole server. Logging it
// here lets the pool quietly create a fresh connection on the next query
// instead of taking the app down.
pool.on("error", (err) => {
  console.error("Unexpected error on idle Postgres client", err.message);
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get("/", (req, res) => {
  res.send("Backend Running");
});

app.get("/dbcheck", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ success: true, message: "Database reachable" });
  } catch (err) {
    console.error("Error in GET /dbcheck", err);
    res.status(500).json({ success: false, message: "Database not reachable" });
  }
});

// ---------------------------------------------------------------------------
// Authentication
//
// There is exactly one account in this system. Login checks the email
// against ALLOWED_ADMIN_EMAIL and the password against ADMIN_PASSWORD.
// Anyone else -- any other email, blank email, malformed request -- is
// denied with the same "access denied" message, whether or not the email
// looks superficially like a robomanthan.com address.
// ---------------------------------------------------------------------------
app.post("/login", (req, res) => {
  (async () => {
    try {
      const { email, password } = req.body || {};
      const rawEmail = String(email || "").trim().toLowerCase();

      if (rawEmail !== ALLOWED_ADMIN_EMAIL) {
        return res.status(403).json({
          success: false,
          message:
            "Access denied. This inventory system is restricted to authorized users.",
        });
      }

      if (!process.env.ADMIN_PASSWORD || password !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ success: false, message: "Wrong password." });
      }

      const token = jwt.sign(
        { email: ALLOWED_ADMIN_EMAIL, role: "admin" },
        JWT_SECRET,
        { expiresIn: "8h" },
      );
      return res.json({ success: true, role: "admin", token });
    } catch (err) {
      console.error("Error in /login", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  })();
});

// auth middleware
//
// Validates the JWT AND re-checks the email inside it against
// ALLOWED_ADMIN_EMAIL on every single request. This means access control
// does not depend solely on /login having been careful about who it hands
// tokens to -- even a structurally valid, correctly-signed token for any
// other email is rejected here, on every protected route in the app.
function authenticateToken(req, res, next) {
  const auth = req.headers["authorization"];
  if (!auth)
    return res.status(401).json({ success: false, message: "Missing token" });
  const parts = auth.split(" ");
  if (parts.length !== 2)
    return res
      .status(401)
      .json({ success: false, message: "Invalid token format" });
  const token = parts[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const tokenEmail = String(payload.email || "").trim().toLowerCase();
    if (tokenEmail !== ALLOWED_ADMIN_EMAIL) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. This inventory system is restricted to authorized users.",
      });
    }
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: "Invalid token" });
  }
}

// Single-account system: every authenticated user is the admin. This check
// is kept as an explicit, separate step (rather than folded into
// authenticateToken) so route-level intent stays obvious and so it keeps
// working unchanged if a second internal role is ever reintroduced.
function requireAdmin(req, res, next) {
  if (!req.user)
    return res
      .status(401)
      .json({ success: false, message: "Not authenticated" });
  if (String(req.user.role).toLowerCase() !== "admin")
    return res.status(403).json({ success: false, message: "Admin required" });
  next();
}

// All BESCOM routes require admin access; kept as its own name for
// readability at each route definition below.
const requireBescomAccess = requireAdmin;

app.get("/me", authenticateToken, async (req, res) => {
  res.json({ success: true, user: req.user });
});

app.get("/verify-token", (req, res) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({
      success: false
    });
  }

  try {

    const token = authHeader.split(" ")[1];

    jwt.verify(token, JWT_SECRET);

    res.json({
      success: true
    });

  } catch(err) {

    res.status(401).json({
      success: false
    });

  }
});

// BESCOM REPORT DOWNLOADS
// ============================================================

async function getBescomReportData() {
  const kits = await pool.query(`
    SELECT
      kit_id AS "kitId",
      kit_code AS "kitCode",
      name,
      kit_type AS "kitType",
      total_kits AS "totalKits",
      issued_kits AS "issuedKits",
      damaged_kits AS "damagedKits",
      status,
      description,
      damage_reason AS "damageReason",
      damage_description AS "damageDescription",
      iami_number AS "iamiNumber",
      notes
    FROM bescom_kits
    ORDER BY name
  `);

  const components = await pool.query(`
    SELECT
      component_id AS "componentId",
      component_code AS "componentCode",
      serial_number AS "serialNumber",
      name,
      category,
      total_quantity AS "totalQuantity",
      issued_quantity AS "issuedQuantity",
      damaged_quantity AS "damagedQuantity",
      status,
      description,
      damage_reason AS "damageReason",
      damage_description AS "damageDescription",
      iami_number AS "iamiNumber",
      notes
    FROM bescom_components
    ORDER BY name
  `);

  const deployments = await pool.query(`
    SELECT
      deployment_id AS "deploymentId",
      place_name AS "placeName",
      location,
      kits_taken AS "kitsTaken",
      kits_returned AS "kitsReturned",
      date_taken AS "dateTaken",
      purpose,
      responsible_person AS "responsiblePerson",
      status,
      iami_number AS "iamiNumber",
      notes
    FROM bescom_deployments
    ORDER BY date_taken DESC
  `);

  const deploymentComponents = await pool.query(`
    SELECT
      dc.deployment_id AS "deploymentId",
      c.component_code AS "componentCode",
      c.name AS "componentName",
      dc.quantity_taken AS "quantityTaken",
      dc.quantity_returned AS "quantityReturned"
    FROM bescom_deployment_components dc
    JOIN bescom_components c
      ON c.component_id = dc.component_id
    ORDER BY dc.deployment_id DESC, c.name
  `);

  const deploymentKits = await pool.query(`
    SELECT
      dk.deployment_id AS "deploymentId",
      k.kit_code AS "kitCode",
      k.name AS "kitName",
      dk.quantity_taken AS "quantityTaken",
      dk.quantity_returned AS "quantityReturned"
    FROM bescom_deployment_kits dk
    JOIN bescom_kits k
      ON k.kit_id = dk.kit_id
    ORDER BY dk.deployment_id DESC, k.name
  `);

  return {
    kits: kits.rows,
    components: components.rows,
    deployments: deployments.rows,
    deploymentComponents: deploymentComponents.rows,
    deploymentKits: deploymentKits.rows,
  };
}


app.get(
  "/bescom/reports/pdf",
  authenticateToken,
  requireBescomAccess,
  async (req, res) => {
    try {
      console.log("Generating BESCOM component inventory PDF report...");

      // The BESCOM UI is now components-only, so this report reflects the
      // current bescom_components data only (kits/deployments are no
      // longer part of the BESCOM screen).
      const componentsRes = await pool.query(`
        SELECT
          component_id AS "componentId",
          component_code AS "componentCode",
          serial_number AS "serialNumber",
          name,
          category,
          total_quantity AS "totalQuantity",
          issued_quantity AS "issuedQuantity",
          damaged_quantity AS "damagedQuantity",
          status,
          description,
          damage_reason AS "damageReason",
          damage_description AS "damageDescription",
          notes
        FROM bescom_components
        ORDER BY name
      `);
      const components = componentsRes.rows.map((c) => ({
        ...c,
        availableQuantity:
          Number(c.totalQuantity || 0) - Number(c.issuedQuantity || 0) - Number(c.damagedQuantity || 0),
      }));

      const doc = new PDFDocument({ size: "A4", margin: pdfTheme.PAGE_MARGIN, bufferPages: true });
      const chunks = [];

      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => {
        const pdf = Buffer.concat(chunks);
        const fileName = `BESCOM_Component_Inventory_Report_${new Date().toISOString().slice(0, 10)}.pdf`;
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
        res.send(pdf);
      });

      const headerOpts = {
        title: "BESCOM Component Inventory Report",
        subtitle: "BESCOM Module",
        meta: `Generated: ${pdfTheme.fmtDate(new Date())}`,
      };
      let y = pdfTheme.drawHeader(doc, headerOpts);

      // SUMMARY
      const totalStock = components.reduce((sum, c) => sum + Number(c.totalQuantity || 0), 0);
      const availableStock = components.reduce((sum, c) => sum + Number(c.availableQuantity || 0), 0);
      const damagedStock = components.reduce((sum, c) => sum + Number(c.damagedQuantity || 0), 0);

      y = pdfTheme.drawKpiCards(
        doc,
        [
          { label: "Total Components", value: components.length },
          { label: "Total Stock", value: totalStock },
          { label: "Available Stock", value: availableStock },
          { label: "Damaged Quantity", value: damagedStock },
        ],
        y,
      );

      // COMPONENTS TABLE
      y = pdfTheme.sectionTitle(doc, "Components", y);
      pdfTheme.drawTable(doc, {
        columns: [
          { header: "Component Name", key: "name" },
          { header: "Serial Number", key: "serialNumber", width: 70, align: "right" },
          { header: "Total Stock", key: "totalQuantity", width: 60, align: "right" },
          { header: "Available", key: "availableQuantity", width: 60, align: "right" },
          { header: "Damaged", key: "damagedQuantity", width: 55, align: "right" },
          { header: "Damage Reason", key: "damageReason", width: 90 },
          { header: "Status", key: "status", width: 55 },
        ],
        rows: components,
        startY: y,
        pageHeaderOpts: headerOpts,
        emptyText: "No BESCOM components on file.",
      });

      pdfTheme.finalizeWithFooters(doc);
      doc.end();

    } catch (err) {
      console.error("BESCOM PDF report error:", err);

      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          message: "Failed to generate BESCOM component inventory PDF report",
          error: err.message,
        });
      }
    }
  }
);


// ==================== EXCEL ====================

app.get(
  "/bescom/reports/excel",
  authenticateToken,
  requireBescomAccess,
  async (req, res) => {
    try {
      console.log("Generating BESCOM Excel report...");

      const data = await getBescomReportData();

      const workbook = new ExcelJS.Workbook();

      workbook.creator = "Robo Inventory";
      workbook.created = new Date();

      // SUMMARY
      const summary = workbook.addWorksheet("Summary");

      summary.columns = [
        { header: "Metric", key: "metric", width: 30 },
        { header: "Value", key: "value", width: 20 },
      ];

      const totalKits = data.kits.reduce(
        (sum, k) => sum + Number(k.totalKits || 0),
        0
      );

      const availableKits = data.kits.reduce(
        (sum, k) =>
          sum +
          Number(k.totalKits || 0) -
          Number(k.issuedKits || 0) -
          Number(k.damagedKits || 0),
        0
      );

      const totalComponents = data.components.reduce(
        (sum, c) => sum + Number(c.totalQuantity || 0),
        0
      );

      const availableComponents = data.components.reduce(
        (sum, c) =>
          sum +
          Number(c.totalQuantity || 0) -
          Number(c.issuedQuantity || 0) -
          Number(c.damagedQuantity || 0),
        0
      );

      summary.addRows([
        ["Generated", new Date()],
        ["Total Kits", totalKits],
        ["Available Kits", availableKits],
        ["Total Components", totalComponents],
        ["Available Components", availableComponents],
        ["Total Deployments", data.deployments.length],
      ]);

      summary.getRow(1).font = { bold: true };

      // KITS
      const kitsSheet = workbook.addWorksheet("Kits");

      kitsSheet.columns = [
        { header: "Kit Code", key: "kitCode", width: 20 },
        { header: "Name", key: "name", width: 30 },
        { header: "Type", key: "kitType", width: 20 },
        { header: "Total", key: "totalKits", width: 12 },
        { header: "Issued", key: "issuedKits", width: 12 },
        { header: "Damaged", key: "damagedKits", width: 12 },
        { header: "Available", key: "available", width: 12 },
        { header: "Status", key: "status", width: 18 },
      ];

      data.kits.forEach((kit) => {
        kitsSheet.addRow({
          kitCode: kit.kitCode,
          name: kit.name,
          kitType: kit.kitType,
          totalKits: Number(kit.totalKits || 0),
          issuedKits: Number(kit.issuedKits || 0),
          damagedKits: Number(kit.damagedKits || 0),
          available:
            Number(kit.totalKits || 0) -
            Number(kit.issuedKits || 0) -
            Number(kit.damagedKits || 0),
          status: kit.status,
        });
      });

      // COMPONENTS
      const componentsSheet =
        workbook.addWorksheet("Components");

      componentsSheet.columns = [
        { header: "Component Name", key: "name", width: 30 },
        { header: "Serial Number", key: "serialNumber", width: 16 },
        { header: "Total Stock", key: "totalQuantity", width: 15 },
        { header: "Available Stock", key: "available", width: 16 },
        { header: "Damaged Quantity", key: "damagedQuantity", width: 17 },
        { header: "Damage Reason", key: "damageReason", width: 24 },
        { header: "Status", key: "status", width: 18 },
        { header: "Category", key: "category", width: 20 },
      ];

      data.components.forEach((component) => {
        componentsSheet.addRow({
          name: component.name,
          serialNumber: component.serialNumber,
          totalQuantity: Number(component.totalQuantity || 0),
          available:
            Number(component.totalQuantity || 0) -
            Number(component.issuedQuantity || 0) -
            Number(component.damagedQuantity || 0),
          damagedQuantity: Number(component.damagedQuantity || 0),
          damageReason: component.damageReason || "-",
          status: component.status,
          category: component.category,
        });
      });

      // DEPLOYMENTS
      const deploymentsSheet =
        workbook.addWorksheet("Deployments");

      deploymentsSheet.columns = [
        { header: "Place", key: "placeName", width: 30 },
        { header: "Location", key: "location", width: 30 },
        { header: "Date Taken", key: "dateTaken", width: 18 },
        { header: "Kits Taken", key: "kitsTaken", width: 15 },
        { header: "Kits Returned", key: "kitsReturned", width: 18 },
        { header: "Purpose", key: "purpose", width: 35 },
        { header: "Responsible Person", key: "responsiblePerson", width: 25 },
        { header: "Status", key: "status", width: 20 },
        { header: "IAMI Number", key: "iamiNumber", width: 20 },
        { header: "Notes", key: "notes", width: 40 },
      ];

      data.deployments.forEach((deployment) => {
        deploymentsSheet.addRow(deployment);
      });

      // DEPLOYMENT KITS
      const deploymentKitsSheet =
        workbook.addWorksheet("Deployment Kits");

      deploymentKitsSheet.columns = [
        { header: "Deployment ID", key: "deploymentId", width: 18 },
        { header: "Kit Code", key: "kitCode", width: 20 },
        { header: "Kit Name", key: "kitName", width: 30 },
        { header: "Taken", key: "quantityTaken", width: 15 },
        { header: "Returned", key: "quantityReturned", width: 15 },
      ];

      data.deploymentKits.forEach((row) => {
        deploymentKitsSheet.addRow(row);
      });

      // DEPLOYMENT COMPONENTS
      const deploymentComponentsSheet =
        workbook.addWorksheet("Deployment Components");

      deploymentComponentsSheet.columns = [
        { header: "Deployment ID", key: "deploymentId", width: 18 },
        { header: "Component Code", key: "componentCode", width: 22 },
        { header: "Component Name", key: "componentName", width: 30 },
        { header: "Taken", key: "quantityTaken", width: 15 },
        { header: "Returned", key: "quantityReturned", width: 15 },
      ];

      data.deploymentComponents.forEach((row) => {
        deploymentComponentsSheet.addRow(row);
      });

      // STYLE -- consistent with the rest of the app's exports
      workbook.worksheets.forEach((sheet) => {
        const headerRow = sheet.getRow(1);
        headerRow.eachCell((cell) => {
          cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E293B" } };
          cell.alignment = { vertical: "middle" };
        });
        headerRow.height = 20;

        sheet.views = [
          {
            state: "frozen",
            ySplit: 1,
          },
        ];

        sheet.eachRow((row, rowNumber) => {
          row.eachCell((cell) => {
            cell.border = { bottom: { style: "thin", color: { argb: "FFE2E8F0" } } };
          });
          if (rowNumber > 1 && rowNumber % 2 === 0) {
            row.eachCell((cell) => {
              cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
            });
          }
        });
      });

      const buffer = await workbook.xlsx.writeBuffer();

      const fileName =
        `BESCOM_Inventory_Report_${new Date()
          .toISOString()
          .slice(0, 10)}.xlsx`;

      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );

      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${fileName}"`
      );

      res.send(buffer);

      console.log("BESCOM Excel report generated successfully.");

    } catch (err) {
      console.error("BESCOM Excel report error:", err);

      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          message: "Failed to generate BESCOM Excel report",
          error: err.message,
        });
      }
    }
  }
);

// ---------- Audit Log ----------
app.get("/audit", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const offset = Number(req.query.offset) || 0;
    const result = await pool.query(
      `
      SELECT log_id AS "logId", actor_email AS "actorEmail", actor_role AS "actorRole",
             action, description, metadata, created_at AS "createdAt"
      FROM audit_logs
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2
      `,
      [limit, offset],
    );
    res.json({ success: true, logs: result.rows });
  } catch (err) {
    console.error("Error in GET /audit", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

/* =========================================================================
   BESCOM MODULE: kits + components inventory, separate from the existing
   SmartStock product catalog. Uses bescom_kits, bescom_components, and
   bescom_kit_components (see migrations/20260811_bescom_module.sql).
   Reuses the existing authenticateToken/requireAdmin middleware and
   logAudit helper. Does not touch any existing routes or tables.
   ========================================================================= */

function bescomKitRow(row) {
  return {
    kitId: row.kitId,
    kitCode: row.kitCode,
    name: row.name,
    kitType: row.kitType,
    totalKits: row.totalKits,
    issuedKits: row.issuedKits,
    damagedKits: row.damagedKits,
    availableKits: row.totalKits - row.issuedKits - row.damagedKits,
    status: row.status,
    description: row.description,
    damageReason: row.damageReason,
    damageDescription: row.damageDescription,
    iamiNumber: row.iamiNumber,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function bescomComponentRow(row) {
  return {
    componentId: row.componentId,
    componentCode: row.componentCode,
    serialNumber: row.serialNumber,
    name: row.name,
    category: row.category,
    totalQuantity: row.totalQuantity,
    issuedQuantity: row.issuedQuantity,
    damagedQuantity: row.damagedQuantity,
    availableQuantity: row.totalQuantity - row.issuedQuantity - row.damagedQuantity,
    status: row.status,
    description: row.description,
    damageReason: row.damageReason,
    damageDescription: row.damageDescription,
    notes: row.notes,
    iamiNumber: row.iamiNumber,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------- Summary cards ----------
// Note: the BESCOM UI is now components-only. totalComponentCount/totalStock/
// availableStock/damagedStock below back the current "Components" summary
// cards. totalKits/availableKits/totalComponents/availableComponents are
// kept in the response for backward compatibility with anything else that
// may still read this endpoint.
app.get("/bescom/summary", authenticateToken, async (req, res) => {
  try {
    const kitsRes = await pool.query(
      `SELECT COALESCE(SUM(total_kits),0) AS "totalKits",
              COALESCE(SUM(total_kits - issued_kits - damaged_kits),0) AS "availableKits"
       FROM bescom_kits`,
    );
    const compRes = await pool.query(
      `SELECT COUNT(*) AS "totalComponentCount",
              COALESCE(SUM(total_quantity),0) AS "totalComponents",
              COALESCE(SUM(total_quantity),0) AS "totalStock",
              COALESCE(SUM(total_quantity - issued_quantity - damaged_quantity),0) AS "availableComponents",
              COALESCE(SUM(total_quantity - issued_quantity - damaged_quantity),0) AS "availableStock",
              COALESCE(SUM(damaged_quantity),0) AS "damagedStock"
       FROM bescom_components`,
    );
    res.json({
      success: true,
      totalKits: Number(kitsRes.rows[0].totalKits),
      availableKits: Number(kitsRes.rows[0].availableKits),
      totalComponents: Number(compRes.rows[0].totalComponents),
      availableComponents: Number(compRes.rows[0].availableComponents),
      totalComponentCount: Number(compRes.rows[0].totalComponentCount),
      totalStock: Number(compRes.rows[0].totalStock),
      availableStock: Number(compRes.rows[0].availableStock),
      damagedStock: Number(compRes.rows[0].damagedStock),
    });
  } catch (err) {
    console.error("Error in GET /bescom/summary", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ---------- Components ----------
app.get("/bescom/components", authenticateToken, async (req, res) => {
  try {
    const { search, category } = req.query;
    const conditions = [];
    const params = [];

    if (search) {
      const trimmed = String(search).trim();
      params.push(`%${trimmed}%`);
      const likeIdx = params.length;
      // Serial Number is an integer column, so it's matched with an exact
      // numeric comparison rather than ILIKE. Only attempted when the
      // search text is actually numeric, so a name/code search like
      // "Antennae" doesn't also try (and fail) a numeric comparison.
      if (/^\d+$/.test(trimmed)) {
        params.push(Number(trimmed));
        const serialIdx = params.length;
        conditions.push(
          `(name ILIKE $${likeIdx} OR component_code ILIKE $${likeIdx} OR serial_number = $${serialIdx})`,
        );
      } else {
        conditions.push(`(name ILIKE $${likeIdx} OR component_code ILIKE $${likeIdx})`);
      }
    }
    if (category) {
      params.push(category);
      conditions.push(`category = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const result = await pool.query(
      `SELECT component_id AS "componentId", component_code AS "componentCode",
              serial_number AS "serialNumber", name, category,
              total_quantity AS "totalQuantity", issued_quantity AS "issuedQuantity",
              damaged_quantity AS "damagedQuantity", status, description,
              damage_reason AS "damageReason", damage_description AS "damageDescription", notes,
              iami_number AS "iamiNumber",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM bescom_components
       ${where}
       ORDER BY name`,
      params,
    );
    res.json({ success: true, components: result.rows.map(bescomComponentRow) });
  } catch (err) {
    console.error("Error in GET /bescom/components", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.get("/bescom/components/:id", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT component_id AS "componentId", component_code AS "componentCode",
              serial_number AS "serialNumber", name, category,
              total_quantity AS "totalQuantity", issued_quantity AS "issuedQuantity",
              damaged_quantity AS "damagedQuantity", status, description,
              damage_reason AS "damageReason", damage_description AS "damageDescription", notes,
              iami_number AS "iamiNumber",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM bescom_components WHERE component_id = $1`,
      [req.params.id],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Component not found" });
    }
    res.json({ success: true, component: bescomComponentRow(result.rows[0]) });
  } catch (err) {
    console.error("Error in GET /bescom/components/:id", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.post("/bescom/components", authenticateToken, requireBescomAccess, async (req, res) => {
  try {
    let {
      componentCode,
      name,
      category,
      quantity,
      damagedQuantity,
      damageReason,
      damageDescription,
      notes,
      iamiNumber,
      description,
      status,
    } = req.body;

    // No field is mandatory -- auto-generate a component code if the user
    // didn't type one, so a record can be saved with e.g. just a name, or
    // just a stock count.
    if (!componentCode) {
      componentCode = `BC-${Date.now().toString(36).toUpperCase()}`;
    }
    const qty = quantity !== undefined && quantity !== "" ? Number(quantity) : 0;
    if (!Number.isFinite(qty) || qty < 0) {
      return res.json({ success: false, message: "Quantity must be a non-negative number" });
    }
    const dmg = damagedQuantity !== undefined && damagedQuantity !== "" ? Number(damagedQuantity) : 0;
    if (!Number.isFinite(dmg) || dmg < 0) {
      return res.json({ success: false, message: "Damaged quantity must be a non-negative number" });
    }
    if (dmg > qty) {
      return res.json({ success: false, message: "Damaged quantity cannot exceed total stock" });
    }

    const result = await pool.query(
      `INSERT INTO bescom_components
         (component_code, name, category, total_quantity, damaged_quantity,
          damage_reason, damage_description, notes, iami_number, description, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11,'Active'))
       RETURNING component_id AS "componentId", serial_number AS "serialNumber"`,
      [
        componentCode,
        name || "",
        category || null,
        qty,
        dmg,
        damageReason || null,
        damageDescription || null,
        notes || null,
        iamiNumber || null,
        description || null,
        status || null,
      ],
    );
    const componentId = result.rows[0].componentId;
    const serialNumber = result.rows[0].serialNumber;

    if (dmg > 0) {
      await pool.query(
        `INSERT INTO damage_history (module, item_id, item_name, damaged_quantity, damage_reason, damage_description, recorded_by)
         VALUES ('bescom_component',$1,$2,$3,$4,$5,$6)`,
        [componentId, name || componentCode, dmg, damageReason || null, damageDescription || null, req.user ? req.user.email : null],
      );
    }

    await logAudit(pool, {
      actorEmail: req.user ? req.user.email : null,
      actorRole: req.user ? req.user.role : null,
      action: "BESCOM_COMPONENT_CREATED",
      description: `${req.user ? req.user.email : "Someone"} added BESCOM component ${name || componentCode} (Serial #${serialNumber})`,
      metadata: { componentCode, name, quantity: qty, serialNumber },
    });

    res.json({ success: true, componentId, serialNumber });
  } catch (err) {
    if (err.code === "23505") {
      return res.json({ success: false, message: "A component with that code already exists" });
    }
    console.error("Error in POST /bescom/components", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.put("/bescom/components/:id", authenticateToken, requireBescomAccess, async (req, res) => {
  try {
    const {
      name,
      category,
      quantity,
      damagedQuantity,
      damageReason,
      damageDescription,
      notes,
      iamiNumber,
      description,
      status,
    } = req.body;
    const existing = await pool.query(
      `SELECT issued_quantity AS "issuedQuantity", damaged_quantity AS "damagedQuantity",
              total_quantity AS "totalQuantity", name
       FROM bescom_components WHERE component_id = $1`,
      [req.params.id],
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Component not found" });
    }
    const prevDamaged = existing.rows[0].damagedQuantity || 0;
    const itemName = name || existing.rows[0].name;
    const { issuedQuantity, damagedQuantity: existingDamaged, totalQuantity: existingTotal } = existing.rows[0];

    let qty;
    if (quantity !== undefined && quantity !== "") {
      qty = Number(quantity);
      if (!Number.isFinite(qty) || qty < 0) {
        return res.json({ success: false, message: "Quantity must be a non-negative number" });
      }
    }

    let dmg;
    if (damagedQuantity !== undefined && damagedQuantity !== "") {
      dmg = Number(damagedQuantity);
      if (!Number.isFinite(dmg) || dmg < 0) {
        return res.json({ success: false, message: "Damaged quantity must be a non-negative number" });
      }
    }

    // Validate the resulting totals together (whichever of qty/dmg wasn't
    // sent in this request keeps its existing value) so it's never possible
    // to end up with damaged > total or issued + damaged > total.
    const effectiveQty = qty !== undefined ? qty : existingTotal;
    const effectiveDmg = dmg !== undefined ? dmg : existingDamaged;
    if (effectiveDmg > effectiveQty) {
      return res.json({ success: false, message: "Damaged quantity cannot exceed total stock" });
    }
    if (effectiveQty < issuedQuantity + effectiveDmg) {
      return res.json({
        success: false,
        message: `Total quantity can't be less than issued + damaged (${issuedQuantity + effectiveDmg})`,
      });
    }

    const result = await pool.query(
      `UPDATE bescom_components
       SET name = COALESCE($1, name),
           category = COALESCE($2, category),
           total_quantity = COALESCE($3, total_quantity),
           damaged_quantity = COALESCE($4, damaged_quantity),
           damage_reason = COALESCE($5, damage_reason),
           damage_description = COALESCE($6, damage_description),
           notes = COALESCE($7, notes),
           iami_number = COALESCE($8, iami_number),
           description = COALESCE($9, description),
           status = COALESCE($10, status),
           updated_at = NOW()
       WHERE component_id = $11
       RETURNING component_id AS "componentId"`,
      [
        name || null,
        category || null,
        qty !== undefined ? qty : null,
        dmg !== undefined ? dmg : null,
        damageReason || null,
        damageDescription || null,
        notes || null,
        iamiNumber || null,
        description || null,
        status || null,
        req.params.id,
      ],
    );

    if (dmg !== undefined && dmg > prevDamaged) {
      await pool.query(
        `INSERT INTO damage_history (module, item_id, item_name, damaged_quantity, damage_reason, damage_description, recorded_by)
         VALUES ('bescom_component',$1,$2,$3,$4,$5,$6)`,
        [req.params.id, itemName, dmg - prevDamaged, damageReason || null, damageDescription || null, req.user ? req.user.email : null],
      );
    }

    await logAudit(pool, {
      actorEmail: req.user ? req.user.email : null,
      actorRole: req.user ? req.user.role : null,
      action: "BESCOM_COMPONENT_UPDATED",
      description: `${req.user ? req.user.email : "Someone"} updated BESCOM component #${req.params.id}`,
      metadata: { componentId: req.params.id },
    });

    res.json({ success: true, componentId: result.rows[0].componentId });
  } catch (err) {
    console.error("Error in PUT /bescom/components/:id", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// DELETE a component. Restricted to the single authorized account, same as
// create/update (requireBescomAccess), and authenticateToken has already
// rejected anything but a token for saurav@robomanthan.com before this
// handler even runs. Actually performs a SQL DELETE against Postgres --
// this is not a frontend-only row removal.
app.delete("/bescom/components/:id", authenticateToken, requireBescomAccess, async (req, res) => {
  try {
    const existing = await pool.query(
      `SELECT component_id AS "componentId", name, component_code AS "componentCode",
              serial_number AS "serialNumber"
       FROM bescom_components WHERE component_id = $1`,
      [req.params.id],
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Component not found" });
    }
    const component = existing.rows[0];

    await pool.query(`DELETE FROM bescom_components WHERE component_id = $1`, [req.params.id]);

    await logAudit(pool, {
      actorEmail: req.user ? req.user.email : null,
      actorRole: req.user ? req.user.role : null,
      action: "BESCOM_COMPONENT_DELETED",
      description: `${req.user ? req.user.email : "Someone"} deleted BESCOM component ${component.name || component.componentCode} (Serial #${component.serialNumber})`,
      metadata: { componentId: component.componentId, serialNumber: component.serialNumber },
    });

    res.json({ success: true, message: "Component deleted successfully" });
  } catch (err) {
    // bescom_kit_components and bescom_deployment_components both reference
    // component_id with ON DELETE RESTRICT, so Postgres blocks deletion of
    // a component that's still attached to a kit or a deployment record.
    // Surface that as a clear, actionable message instead of a generic 500.
    if (err.code === "23503") {
      return res.status(409).json({
        success: false,
        message:
          "This component can't be deleted because it is still used in a BESCOM kit or deployment record. Remove it from those first.",
      });
    }
    console.error("Error in DELETE /bescom/components/:id", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ---------- Kits ----------
app.get("/bescom/kits", authenticateToken, async (req, res) => {
  try {
    const { search } = req.query;
    const params = [];
    let where = "";
    if (search) {
      params.push(`%${search}%`);
      where = `WHERE (name ILIKE $1 OR kit_code ILIKE $1)`;
    }
    const result = await pool.query(
      `SELECT kit_id AS "kitId", kit_code AS "kitCode", name, kit_type AS "kitType",
              total_kits AS "totalKits", issued_kits AS "issuedKits", damaged_kits AS "damagedKits",
              damage_reason AS "damageReason", damage_description AS "damageDescription",
              iami_number AS "iamiNumber", notes,
              status, description, created_at AS "createdAt", updated_at AS "updatedAt"
       FROM bescom_kits
       ${where}
       ORDER BY name`,
      params,
    );
    res.json({ success: true, kits: result.rows.map(bescomKitRow) });
  } catch (err) {
    console.error("Error in GET /bescom/kits", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.get("/bescom/kits/:id", authenticateToken, async (req, res) => {
  try {
    const kitRes = await pool.query(
      `SELECT kit_id AS "kitId", kit_code AS "kitCode", name, kit_type AS "kitType",
              total_kits AS "totalKits", issued_kits AS "issuedKits", damaged_kits AS "damagedKits",
              damage_reason AS "damageReason", damage_description AS "damageDescription",
              iami_number AS "iamiNumber", notes,
              status, description, created_at AS "createdAt", updated_at AS "updatedAt"
       FROM bescom_kits WHERE kit_id = $1`,
      [req.params.id],
    );
    if (kitRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Kit not found" });
    }

    const compRes = await pool.query(
      `SELECT kc.component_id AS "componentId", c.component_code AS "componentCode",
              c.name AS "componentName", kc.required_quantity AS "requiredQuantity"
       FROM bescom_kit_components kc
       JOIN bescom_components c ON c.component_id = kc.component_id
       WHERE kc.kit_id = $1
       ORDER BY c.name`,
      [req.params.id],
    );

    res.json({
      success: true,
      kit: { ...bescomKitRow(kitRes.rows[0]), components: compRes.rows },
    });
  } catch (err) {
    console.error("Error in GET /bescom/kits/:id", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.post("/bescom/kits", authenticateToken, requireBescomAccess, async (req, res) => {
  let { kitCode, name, kitType, totalKits, description, iamiNumber, notes, components } = req.body;

  if (!kitCode) {
    kitCode = `BK-${Date.now().toString(36).toUpperCase()}`;
  }
  const qty = totalKits !== undefined && totalKits !== "" ? Number(totalKits) : 0;
  if (!Number.isFinite(qty) || qty < 0) {
    return res.json({ success: false, message: "Number of kits must be a non-negative number" });
  }
  if (components && !Array.isArray(components)) {
    return res.json({ success: false, message: "Components must be a list" });
  }
  for (const c of components || []) {
    if (!c.componentId || !Number.isFinite(Number(c.requiredQuantity)) || Number(c.requiredQuantity) <= 0) {
      return res.json({ success: false, message: "Each kit component needs a component and a positive quantity per kit" });
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const kitRes = await client.query(
      `INSERT INTO bescom_kits (kit_code, name, kit_type, total_kits, description, iami_number, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING kit_id AS "kitId"`,
      [kitCode, name || "", kitType || null, qty, description || null, iamiNumber || null, notes || null],
    );
    const kitId = kitRes.rows[0].kitId;

    for (const c of components || []) {
      await client.query(
        `INSERT INTO bescom_kit_components (kit_id, component_id, required_quantity)
         VALUES ($1,$2,$3)`,
        [kitId, c.componentId, Number(c.requiredQuantity)],
      );
    }

    await client.query("COMMIT");

    await logAudit(pool, {
      actorEmail: req.user ? req.user.email : null,
      actorRole: req.user ? req.user.role : null,
      action: "BESCOM_KIT_CREATED",
      description: `${req.user ? req.user.email : "Someone"} added BESCOM kit ${name || kitCode}`,
      metadata: { kitCode, name, totalKits: qty },
    });

    res.json({ success: true, kitId });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "23505") {
      return res.json({ success: false, message: "A kit with that Kit ID already exists" });
    }
    console.error("Error in POST /bescom/kits", err);
    res.status(500).json({ success: false, message: "Server error" });
  } finally {
    client.release();
  }
});

app.put("/bescom/kits/:id", authenticateToken, requireBescomAccess, async (req, res) => {
  try {
    const { name, kitType, totalKits, damagedKits, damageReason, damageDescription, description, iamiNumber, notes, status } = req.body;
    const existingRes = await pool.query(
      `SELECT issued_kits AS "issuedKits", damaged_kits AS "damagedKits", name FROM bescom_kits WHERE kit_id = $1`,
      [req.params.id],
    );
    if (existingRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Kit not found" });
    }
    const prevDamaged = existingRes.rows[0].damagedKits || 0;
    const itemName = name || existingRes.rows[0].name;

    let qty;
    if (totalKits !== undefined && totalKits !== "") {
      qty = Number(totalKits);
      const { issuedKits, damagedKits: existingDamaged } = existingRes.rows[0];
      if (!Number.isFinite(qty) || qty < 0) {
        return res.json({ success: false, message: "Number of kits must be a non-negative number" });
      }
      if (qty < issuedKits + existingDamaged) {
        return res.json({
          success: false,
          message: `Number of kits can't be less than issued + damaged (${issuedKits + existingDamaged})`,
        });
      }
    }

    let dmg;
    if (damagedKits !== undefined && damagedKits !== "") {
      dmg = Number(damagedKits);
      if (!Number.isFinite(dmg) || dmg < 0) {
        return res.json({ success: false, message: "Damaged kits must be a non-negative number" });
      }
    }

    const result = await pool.query(
      `UPDATE bescom_kits
       SET name = COALESCE($1, name),
           kit_type = COALESCE($2, kit_type),
           total_kits = COALESCE($3, total_kits),
           damaged_kits = COALESCE($4, damaged_kits),
           damage_reason = COALESCE($5, damage_reason),
           damage_description = COALESCE($6, damage_description),
           description = COALESCE($7, description),
           iami_number = COALESCE($8, iami_number),
           notes = COALESCE($9, notes),
           status = COALESCE($10, status),
           updated_at = NOW()
       WHERE kit_id = $11
       RETURNING kit_id AS "kitId"`,
      [
        name || null,
        kitType || null,
        qty !== undefined ? qty : null,
        dmg !== undefined ? dmg : null,
        damageReason || null,
        damageDescription || null,
        description || null,
        iamiNumber || null,
        notes || null,
        status || null,
        req.params.id,
      ],
    );

    if (dmg !== undefined && dmg > prevDamaged) {
      await pool.query(
        `INSERT INTO damage_history (module, item_id, item_name, damaged_quantity, damage_reason, damage_description, recorded_by)
         VALUES ('bescom_kit',$1,$2,$3,$4,$5,$6)`,
        [req.params.id, itemName, dmg - prevDamaged, damageReason || null, damageDescription || null, req.user ? req.user.email : null],
      );
    }

    await logAudit(pool, {
      actorEmail: req.user ? req.user.email : null,
      actorRole: req.user ? req.user.role : null,
      action: "BESCOM_KIT_UPDATED",
      description: `${req.user ? req.user.email : "Someone"} updated BESCOM kit #${req.params.id}`,
      metadata: { kitId: req.params.id },
    });

    res.json({ success: true, kitId: result.rows[0].kitId });
  } catch (err) {
    console.error("Error in PUT /bescom/kits/:id", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Replace the full set of components (and required quantities) for a kit
app.post("/bescom/kits/:id/components", authenticateToken, requireBescomAccess, async (req, res) => {
  const { components } = req.body;
  if (!Array.isArray(components)) {
    return res.json({ success: false, message: "Components must be a list" });
  }
  for (const c of components) {
    if (!c.componentId || !Number.isFinite(Number(c.requiredQuantity)) || Number(c.requiredQuantity) <= 0) {
      return res.json({ success: false, message: "Each kit component needs a component and a positive quantity per kit" });
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const kitRes = await client.query(`SELECT kit_id FROM bescom_kits WHERE kit_id = $1 FOR UPDATE`, [req.params.id]);
    if (kitRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Kit not found" });
    }

    await client.query(`DELETE FROM bescom_kit_components WHERE kit_id = $1`, [req.params.id]);
    for (const c of components) {
      await client.query(
        `INSERT INTO bescom_kit_components (kit_id, component_id, required_quantity) VALUES ($1,$2,$3)`,
        [req.params.id, c.componentId, Number(c.requiredQuantity)],
      );
    }

    await client.query("COMMIT");

    await logAudit(pool, {
      actorEmail: req.user ? req.user.email : null,
      actorRole: req.user ? req.user.role : null,
      action: "BESCOM_KIT_COMPONENTS_UPDATED",
      description: `${req.user ? req.user.email : "Someone"} updated components for BESCOM kit #${req.params.id}`,
      metadata: { kitId: req.params.id, componentCount: components.length },
    });

    res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error in POST /bescom/kits/:id/components", err);
    res.status(500).json({ success: false, message: "Server error" });
  } finally {
    client.release();
  }
});

/* =========================================================================
   BESCOM USAGE & DEPLOYMENT: tracks kits/components taken to colleges,
   sites, etc. Uses bescom_deployments, bescom_deployment_components, and
   bescom_deployment_kits (see migrations/20260811b_bescom_deployments.sql).
   Reuses bescom_kits/bescom_components for inventory counts -- taking a
   deployment increments issued_kits/issued_quantity on those tables;
   returning it decrements them back. Does not touch the BESCOM kit/
   component CRUD routes above, or any non-BESCOM route.
   ========================================================================= */

function deploymentRow(row) {
  return {
    placeName: row.placeName,
    location: row.location,
    kitsTaken: row.kitsTaken,
    kitsReturned: row.kitsReturned,
    dateTaken: row.dateTaken,
    purpose: row.purpose,
    responsiblePerson: row.responsiblePerson,
    status: row.status,
    iamiNumber: row.iamiNumber,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    // deploymentId is included so the frontend can call detail/edit/return
    // endpoints -- it is never rendered as a visible "ID" column/field.
    deploymentId: row.deploymentId,
  };
}

// ---------- Summary cards ----------
app.get("/bescom/deployments/summary", authenticateToken, async (req, res) => {
  try {
    const depRes = await pool.query(
      `SELECT COALESCE(SUM(kits_taken),0) AS "totalKitsTaken",
              COUNT(*) FILTER (WHERE status = 'In Use') AS "currentlyInUse",
              COUNT(*) FILTER (WHERE status = 'Returned') AS "returned",
              COUNT(DISTINCT place_name) AS "placesCount"
       FROM bescom_deployments`,
    );
    const compRes = await pool.query(
      `SELECT COALESCE(SUM(quantity_taken),0) AS "totalComponentsTaken" FROM bescom_deployment_components`,
    );
    res.json({
      success: true,
      totalKitsTaken: Number(depRes.rows[0].totalKitsTaken),
      totalComponentsTaken: Number(compRes.rows[0].totalComponentsTaken),
      currentlyInUse: Number(depRes.rows[0].currentlyInUse),
      returned: Number(depRes.rows[0].returned),
      placesCount: Number(depRes.rows[0].placesCount),
    });
  } catch (err) {
    console.error("Error in GET /bescom/deployments/summary", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ---------- List ----------
app.get("/bescom/deployments", authenticateToken, async (req, res) => {
  try {
    const { search, status } = req.query;
    const conditions = [];
    const params = [];
    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(place_name ILIKE $${params.length} OR location ILIKE $${params.length})`);
    }
    if (status) {
      params.push(status);
      conditions.push(`status = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const depRes = await pool.query(
      `SELECT deployment_id AS "deploymentId", place_name AS "placeName", location,
              kits_taken AS "kitsTaken", kits_returned AS "kitsReturned",
              date_taken AS "dateTaken", purpose, responsible_person AS "responsiblePerson",
              status, iami_number AS "iamiNumber", notes, created_at AS "createdAt", updated_at AS "updatedAt"
       FROM bescom_deployments
       ${where}
       ORDER BY date_taken DESC, deployment_id DESC`,
      params,
    );

    const ids = depRes.rows.map((r) => r.deploymentId);
    let componentsByDeployment = {};
    if (ids.length > 0) {
      const compRes = await pool.query(
        `SELECT dc.deployment_id AS "deploymentId", SUM(dc.quantity_taken) AS "componentsTaken"
         FROM bescom_deployment_components dc
         WHERE dc.deployment_id = ANY($1)
         GROUP BY dc.deployment_id`,
        [ids],
      );
      compRes.rows.forEach((r) => {
        componentsByDeployment[r.deploymentId] = Number(r.componentsTaken);
      });
    }

    const deployments = depRes.rows.map((row) => ({
      ...deploymentRow(row),
      componentsTaken: componentsByDeployment[row.deploymentId] || 0,
    }));

    res.json({ success: true, deployments });
  } catch (err) {
    console.error("Error in GET /bescom/deployments", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ---------- Details ----------
app.get("/bescom/deployments/:id", authenticateToken, async (req, res) => {
  try {
    const depRes = await pool.query(
      `SELECT deployment_id AS "deploymentId", place_name AS "placeName", location,
              kits_taken AS "kitsTaken", kits_returned AS "kitsReturned",
              date_taken AS "dateTaken", purpose, responsible_person AS "responsiblePerson",
              status, iami_number AS "iamiNumber", notes, created_at AS "createdAt", updated_at AS "updatedAt"
       FROM bescom_deployments WHERE deployment_id = $1`,
      [req.params.id],
    );
    if (depRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Deployment not found" });
    }

    const compRes = await pool.query(
      `SELECT c.component_id AS "componentId", c.name AS "componentName", c.component_code AS "componentCode",
              dc.quantity_taken AS "quantityTaken", dc.quantity_returned AS "quantityReturned"
       FROM bescom_deployment_components dc
       JOIN bescom_components c ON c.component_id = dc.component_id
       WHERE dc.deployment_id = $1
       ORDER BY c.name`,
      [req.params.id],
    );

    res.json({
      success: true,
      deployment: { ...deploymentRow(depRes.rows[0]), components: compRes.rows },
    });
  } catch (err) {
    console.error("Error in GET /bescom/deployments/:id", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ---------- Create ----------
// body: { placeName, location, kitsTaken, dateTaken, purpose, responsiblePerson,
//         status, components: [{componentId, quantity}] }
app.post("/bescom/deployments", authenticateToken, requireBescomAccess, async (req, res) => {
  const { placeName, location, kitsTaken, dateTaken, purpose, responsiblePerson, iamiNumber, notes, status, components } = req.body;
  const kitsQty = kitsTaken !== undefined && kitsTaken !== "" ? Number(kitsTaken) : 0;

  if (!Number.isFinite(kitsQty) || kitsQty < 0) {
    return res.json({ success: false, message: "Number of Kits Taken must be a non-negative number" });
  }
  if (components && !Array.isArray(components)) {
    return res.json({ success: false, message: "Components must be a list" });
  }
  for (const c of components || []) {
    if (!c.componentId || !Number.isFinite(Number(c.quantity)) || Number(c.quantity) <= 0) {
      return res.json({ success: false, message: "Each component needs a valid component and a positive quantity" });
    }
  }
  if (
    !placeName &&
    kitsQty === 0 &&
    !(components && components.length) &&
    !purpose &&
    !responsiblePerson &&
    !notes &&
    !iamiNumber
  ) {
    return res.json({ success: false, message: "Enter at least one piece of information" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ---- Validate & allocate kits across bescom_kits rows ----
    let kitAllocations = [];
    if (kitsQty > 0) {
      const kitsRes = await client.query(
        `SELECT kit_id AS "kitId", total_kits AS "totalKits", issued_kits AS "issuedKits", damaged_kits AS "damagedKits"
         FROM bescom_kits
         ORDER BY (total_kits - issued_kits - damaged_kits) DESC
         FOR UPDATE`,
      );
      const totalAvailable = kitsRes.rows.reduce(
        (sum, k) => sum + (k.totalKits - k.issuedKits - k.damagedKits),
        0,
      );
      if (kitsQty > totalAvailable) {
        await client.query("ROLLBACK");
        return res.json({ success: false, message: `Only ${totalAvailable} kits are currently available.` });
      }
      let remaining = kitsQty;
      for (const k of kitsRes.rows) {
        if (remaining <= 0) break;
        const available = k.totalKits - k.issuedKits - k.damagedKits;
        if (available <= 0) continue;
        const take = Math.min(available, remaining);
        kitAllocations.push({ kitId: k.kitId, quantity: take });
        remaining -= take;
      }
    }

    // ---- Validate components ----
    for (const c of components || []) {
      const compRes = await client.query(
        `SELECT component_id AS "componentId", name, total_quantity AS "totalQuantity",
                issued_quantity AS "issuedQuantity", damaged_quantity AS "damagedQuantity"
         FROM bescom_components WHERE component_id = $1 FOR UPDATE`,
        [c.componentId],
      );
      if (compRes.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.json({ success: false, message: "One of the selected components does not exist in BESCOM inventory" });
      }
      const comp = compRes.rows[0];
      const available = comp.totalQuantity - comp.issuedQuantity - comp.damagedQuantity;
      if (Number(c.quantity) > available) {
        await client.query("ROLLBACK");
        return res.json({ success: false, message: `Only ${available} ${comp.name} are currently available.` });
      }
    }

    // ---- Create deployment ----
    const depRes = await client.query(
      `INSERT INTO bescom_deployments (place_name, location, kits_taken, date_taken, purpose, responsible_person, iami_number, notes, status)
       VALUES ($1,$2,$3,COALESCE($4, CURRENT_DATE),$5,$6,$7,$8,COALESCE($9,'In Use'))
       RETURNING deployment_id AS "deploymentId"`,
      [placeName || "", location || null, kitsQty, dateTaken || null, purpose || null, responsiblePerson || null, iamiNumber || null, notes || null, status || null],
    );
    const deploymentId = depRes.rows[0].deploymentId;

    for (const alloc of kitAllocations) {
      await client.query(
        `INSERT INTO bescom_deployment_kits (deployment_id, kit_id, quantity_taken) VALUES ($1,$2,$3)`,
        [deploymentId, alloc.kitId, alloc.quantity],
      );
      await client.query(`UPDATE bescom_kits SET issued_kits = issued_kits + $1, updated_at = NOW() WHERE kit_id = $2`, [
        alloc.quantity,
        alloc.kitId,
      ]);
    }

    let totalComponentsTaken = 0;
    for (const c of components || []) {
      const qty = Number(c.quantity);
      totalComponentsTaken += qty;
      await client.query(
        `INSERT INTO bescom_deployment_components (deployment_id, component_id, quantity_taken) VALUES ($1,$2,$3)`,
        [deploymentId, c.componentId, qty],
      );
      await client.query(
        `UPDATE bescom_components SET issued_quantity = issued_quantity + $1, updated_at = NOW() WHERE component_id = $2`,
        [qty, c.componentId],
      );
    }

    await client.query("COMMIT");

    await logAudit(pool, {
      actorEmail: req.user ? req.user.email : null,
      actorRole: req.user ? req.user.role : null,
      action: "BESCOM_USAGE_CREATED",
      description: `${req.user ? req.user.email : "Someone"} recorded BESCOM usage at ${placeName}: ${kitsQty} kits, ${totalComponentsTaken} components`,
      metadata: { deploymentId, placeName, kitsTaken: kitsQty, componentsTaken: totalComponentsTaken },
    });

    res.json({ success: true, deploymentId });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error in POST /bescom/deployments", err);
    res.status(500).json({ success: false, message: "Server error" });
  } finally {
    client.release();
  }
});

// ---------- Update (place/location/purpose/responsible person/status text fields) ----------
app.put("/bescom/deployments/:id", authenticateToken, requireBescomAccess, async (req, res) => {
  try {
    const { placeName, location, purpose, responsiblePerson, dateTaken, iamiNumber, notes, status } = req.body;
    const existing = await pool.query(`SELECT deployment_id FROM bescom_deployments WHERE deployment_id = $1`, [
      req.params.id,
    ]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Deployment not found" });
    }
    if (status && !["In Use", "Returned", "Partially Returned", "Completed"].includes(status)) {
      return res.json({ success: false, message: "Invalid status" });
    }

    const result = await pool.query(
      `UPDATE bescom_deployments
       SET place_name = COALESCE($1, place_name),
           location = COALESCE($2, location),
           purpose = COALESCE($3, purpose),
           responsible_person = COALESCE($4, responsible_person),
           date_taken = COALESCE($5, date_taken),
           iami_number = COALESCE($6, iami_number),
           notes = COALESCE($7, notes),
           status = COALESCE($8, status),
           updated_at = NOW()
       WHERE deployment_id = $9
       RETURNING deployment_id AS "deploymentId"`,
      [placeName || null, location || null, purpose || null, responsiblePerson || null, dateTaken || null, iamiNumber || null, notes || null, status || null, req.params.id],
    );

    await logAudit(pool, {
      actorEmail: req.user ? req.user.email : null,
      actorRole: req.user ? req.user.role : null,
      action: "BESCOM_USAGE_UPDATED",
      description: `${req.user ? req.user.email : "Someone"} updated BESCOM usage record #${req.params.id}`,
      metadata: { deploymentId: req.params.id },
    });

    res.json({ success: true, deploymentId: result.rows[0].deploymentId });
  } catch (err) {
    console.error("Error in PUT /bescom/deployments/:id", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ---------- Mark Returned (full or partial) ----------
// body: {} for a full return of everything still outstanding, or
// { kitsReturned, components: [{componentId, quantityReturned}] } for a
// partial return of specific amounts.
app.post("/bescom/deployments/:id/return", authenticateToken, requireBescomAccess, async (req, res) => {
  const { kitsReturned, components } = req.body;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const depRes = await client.query(
      `SELECT deployment_id AS "deploymentId", kits_taken AS "kitsTaken", kits_returned AS "kitsReturned", status
       FROM bescom_deployments WHERE deployment_id = $1 FOR UPDATE`,
      [req.params.id],
    );
    if (depRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Deployment not found" });
    }
    const deployment = depRes.rows[0];
    if (deployment.status === "Returned") {
      await client.query("ROLLBACK");
      return res.json({ success: false, message: "This deployment has already been fully returned" });
    }

    // ---- Kits: how many to return this time ----
    const kitsOutstanding = deployment.kitsTaken - deployment.kitsReturned;
    let kitsToReturn = kitsReturned !== undefined ? Number(kitsReturned) : kitsOutstanding;
    if (!Number.isFinite(kitsToReturn) || kitsToReturn < 0) {
      await client.query("ROLLBACK");
      return res.json({ success: false, message: "Kits returned must be a non-negative number" });
    }
    if (kitsToReturn > kitsOutstanding) {
      await client.query("ROLLBACK");
      return res.json({ success: false, message: `Only ${kitsOutstanding} kits from this deployment are still outstanding.` });
    }

    if (kitsToReturn > 0) {
      const allocRes = await client.query(
        `SELECT id, kit_id AS "kitId", quantity_taken AS "quantityTaken", quantity_returned AS "quantityReturned"
         FROM bescom_deployment_kits WHERE deployment_id = $1 FOR UPDATE`,
        [req.params.id],
      );
      let remaining = kitsToReturn;
      for (const alloc of allocRes.rows) {
        if (remaining <= 0) break;
        const outstanding = alloc.quantityTaken - alloc.quantityReturned;
        if (outstanding <= 0) continue;
        const give = Math.min(outstanding, remaining);
        await client.query(`UPDATE bescom_deployment_kits SET quantity_returned = quantity_returned + $1 WHERE id = $2`, [
          give,
          alloc.id,
        ]);
        await client.query(`UPDATE bescom_kits SET issued_kits = issued_kits - $1, updated_at = NOW() WHERE kit_id = $2`, [
          give,
          alloc.kitId,
        ]);
        remaining -= give;
      }
    }

    // ---- Components: explicit list, or everything outstanding ----
    let componentsToReturn = components;
    if (!componentsToReturn) {
      const outstandingCompsRes = await client.query(
        `SELECT component_id AS "componentId", quantity_taken AS "quantityTaken", quantity_returned AS "quantityReturned"
         FROM bescom_deployment_components WHERE deployment_id = $1`,
        [req.params.id],
      );
      componentsToReturn = outstandingCompsRes.rows
        .filter((r) => r.quantityTaken - r.quantityReturned > 0)
        .map((r) => ({ componentId: r.componentId, quantityReturned: r.quantityTaken - r.quantityReturned }));
    }

    for (const c of componentsToReturn) {
      const qty = Number(c.quantityReturned);
      if (!c.componentId || !Number.isFinite(qty) || qty <= 0) continue;

      const rowRes = await client.query(
        `SELECT quantity_taken AS "quantityTaken", quantity_returned AS "quantityReturned"
         FROM bescom_deployment_components WHERE deployment_id = $1 AND component_id = $2 FOR UPDATE`,
        [req.params.id, c.componentId],
      );
      if (rowRes.rows.length === 0) continue;
      const outstanding = rowRes.rows[0].quantityTaken - rowRes.rows[0].quantityReturned;
      if (qty > outstanding) {
        await client.query("ROLLBACK");
        return res.json({ success: false, message: `Only ${outstanding} of that component from this deployment are still outstanding.` });
      }

      await client.query(
        `UPDATE bescom_deployment_components SET quantity_returned = quantity_returned + $1 WHERE deployment_id = $2 AND component_id = $3`,
        [qty, req.params.id, c.componentId],
      );
      await client.query(
        `UPDATE bescom_components SET issued_quantity = issued_quantity - $1, updated_at = NOW() WHERE component_id = $2`,
        [qty, c.componentId],
      );
    }

    // ---- Recompute deployment status ----
    const newKitsReturned = deployment.kitsReturned + kitsToReturn;
    const totalsRes = await client.query(
      `SELECT COALESCE(SUM(quantity_taken),0) AS "taken", COALESCE(SUM(quantity_returned),0) AS "returned"
       FROM bescom_deployment_components WHERE deployment_id = $1`,
      [req.params.id],
    );
    const compsFullyReturned = Number(totalsRes.rows[0].taken) === Number(totalsRes.rows[0].returned);
    const kitsFullyReturned = newKitsReturned === deployment.kitsTaken;

    let newStatus;
    if (kitsFullyReturned && compsFullyReturned) newStatus = "Returned";
    else if (newKitsReturned > 0 || Number(totalsRes.rows[0].returned) > 0) newStatus = "Partially Returned";
    else newStatus = deployment.status;

    await client.query(
      `UPDATE bescom_deployments SET kits_returned = $1, status = $2, updated_at = NOW() WHERE deployment_id = $3`,
      [newKitsReturned, newStatus, req.params.id],
    );

    await client.query("COMMIT");

    await logAudit(pool, {
      actorEmail: req.user ? req.user.email : null,
      actorRole: req.user ? req.user.role : null,
      action: "BESCOM_USAGE_RETURNED",
      description: `${req.user ? req.user.email : "Someone"} recorded a return for BESCOM usage #${req.params.id} (${kitsToReturn} kits)`,
      metadata: { deploymentId: req.params.id, kitsReturned: kitsToReturn, newStatus },
    });

    res.json({ success: true, status: newStatus });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error in POST /bescom/deployments/:id/return", err);
    res.status(500).json({ success: false, message: "Server error" });
  } finally {
    client.release();
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Configured DB host: ${process.env.DB_HOST}`);
  pool
    .query("SELECT 1")
    .then(() => console.log("✅ Database connection OK"))
    .catch((err) =>
      console.error(
        "❌ Could NOT connect to the database. Check backend/.env (DB_HOST/DB_USER/DB_PASSWORD) and that this Neon project is awake. Details:",
        err.message,
      ),
    );
});

// Keep-warm ping: Neon's free tier suspends its compute after a period of
// inactivity, and the first query after that can be slow enough to time out
// (this is what causes "the server feels slow" and occasional connection
// errors). Pinging every 4 minutes keeps the connection warm during active
// use without meaningfully affecting Neon's usage quota. This has no effect
// once you close the server -- it only helps while you're actively testing.
setInterval(() => {
  pool.query("SELECT 1").catch((err) => {
    console.error("Keep-warm ping failed (this is usually harmless):", err.message);
  });
}, 4 * 60 * 1000);
