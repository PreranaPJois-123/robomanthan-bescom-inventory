const express = require("express");
require("dotenv").config();

const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");
const { logAudit } = require("./audit");
const pdfTheme = require("./pdfTheme");

const JWT_SECRET = process.env.JWT_SECRET;
const app = express();

// ---------------------------------------------------------------------------
// CORS
//
// Development origins (localhost:5500 / 127.0.0.1:5500, e.g. VS Code's
// "Live Server") are fixed and safe to hard-code. The production frontend
// origin (Hostinger) is NOT hard-coded here -- it comes from the
// FRONTEND_URL environment variable, since baking a specific domain into
// source is exactly the kind of security-sensitive config that should live
// in the deployment environment (Render) instead. FRONTEND_URL may be a
// single origin or a comma-separated list, in case more than one frontend
// origin needs to be allowed later.
const allowedOrigins = [
  "http://localhost:5500",
  "http://127.0.0.1:5500",
];

if (process.env.FRONTEND_URL) {
  process.env.FRONTEND_URL.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .forEach((origin) => allowedOrigins.push(origin));
}

const corsOptions = {
  origin: function (origin, callback) {
    // No Origin header (server-to-server calls, curl, health checks) --
    // allow, same as before.
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

app.use(cors(corsOptions));

// NOTE: there is intentionally no separate `app.options(...)` call here.
// The line that used to be here -- app.options("*", cors()) -- crashes on
// startup on the Express version installed in this project (Express 5,
// which uses path-to-regexp v6+): a bare "*" is no longer a valid route
// pattern there ("Missing parameter name at index 1: *"), and the
// regex form app.options(/.*/, cors()) has the same underlying
// incompatibility. Neither is needed anyway: the `cors` middleware
// mounted above via app.use() already intercepts and answers OPTIONS
// preflight requests for every route on its own (this is standard
// behavior of the `cors` npm package, not something specific to this
// app) -- app.use() matches all HTTP methods, including OPTIONS, so no
// extra wildcard route registration is required.
app.use(express.json());

// ===========================================================================
// SINGLE-TENANT, SINGLE-USER ACCESS CONTROL
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
// ---------------------------------------------------------------------------
app.post("/login", async (req, res) => {
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
      { expiresIn: "8h" }
    );
    return res.json({ success: true, role: "admin", token });
  } catch (err) {
    console.error("Error in /login", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

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

function requireAdmin(req, res, next) {
  if (!req.user)
    return res
      .status(401)
      .json({ success: false, message: "Not authenticated" });
  if (String(req.user.role).toLowerCase() !== "admin")
    return res.status(403).json({ success: false, message: "Admin required" });
  next();
}

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
  } catch (err) {
    res.status(401).json({
      success: false
    });
  }
});

// ============================================================
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
        y
      );

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

      const summary = workbook.addWorksheet("Summary");
      summary.columns = [
        { header: "Metric", key: "metric", width: 30 },
        { header: "Value", key: "value", width: 20 },
      ];

      const totalKits = data.kits.reduce((sum, k) => sum + Number(k.totalKits || 0), 0);
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

      const componentsSheet = workbook.addWorksheet("Components");
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

      const deploymentsSheet = workbook.addWorksheet("Deployments");
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

      const deploymentKitsSheet = workbook.addWorksheet("Deployment Kits");
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

      const deploymentComponentsSheet = workbook.addWorksheet("Deployment Components");
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

      workbook.worksheets.forEach((sheet) => {
        const headerRow = sheet.getRow(1);
        headerRow.eachCell((cell) => {
          cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E293B" } };
          cell.alignment = { vertical: "middle" };
        });
        headerRow.height = 20;

        sheet.views = [{ state: "frozen", ySplit: 1 }];

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
      const fileName = `BESCOM_Inventory_Report_${new Date().toISOString().slice(0, 10)}.xlsx`;

      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
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
      [limit, offset]
    );
    res.json({ success: true, logs: result.rows });
  } catch (err) {
    console.error("Error in GET /audit", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// =========================================================================
// BESCOM MODULE: Helper functions
// =========================================================================

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
app.get("/bescom/summary", authenticateToken, async (req, res) => {
  try {
    const kitsRes = await pool.query(
      `SELECT COALESCE(SUM(total_kits),0) AS "totalKits",
              COALESCE(SUM(total_kits - issued_kits - damaged_kits),0) AS "availableKits"
       FROM bescom_kits`
    );
    const compRes = await pool.query(
      `SELECT COUNT(*) AS "totalComponentCount",
              COALESCE(SUM(total_quantity),0) AS "totalComponents",
              COALESCE(SUM(total_quantity),0) AS "totalStock",
              COALESCE(SUM(total_quantity - issued_quantity - damaged_quantity),0) AS "availableComponents",
              COALESCE(SUM(total_quantity - issued_quantity - damaged_quantity),0) AS "availableStock",
              COALESCE(SUM(damaged_quantity),0) AS "damagedStock"
       FROM bescom_components`
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
      if (/^\d+$/.test(trimmed)) {
        params.push(Number(trimmed));
        const serialIdx = params.length;
        conditions.push(
          `(name ILIKE $${likeIdx} OR component_code ILIKE $${likeIdx} OR serial_number = $${serialIdx})`
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
      params
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
      [req.params.id]
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
      ]
    );
    const componentId = result.rows[0].componentId;
    const serialNumber = result.rows[0].serialNumber;

    if (dmg > 0) {
      await pool.query(
        `INSERT INTO damage_history (module, item_id, item_name, damaged_quantity, damage_reason, damage_description, recorded_by)
         VALUES ('bescom_component',$1,$2,$3,$4,$5,$6)`,
        [componentId, name || componentCode, dmg, damageReason || null, damageDescription || null, req.user ? req.user.email : null]
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
    console.error("Error in POST /bescom/components", err);
    if (err.code === "23505") {
      return res.status(400).json({
        success: false,
        message: "Component code or serial number already exists.",
      });
    }
    return res.status(500).json({
      success: false,
      message: "Server error creating component",
    });
  }
});

// The Edit (PUT) and Delete (DELETE) routes below were missing from this
// version of the file even though the frontend (bescom.js) already calls
// both of them and the UI has working Edit/Delete buttons -- without these,
// those buttons 404. Restored here using the same patterns as the routes
// immediately above (authenticateToken + requireBescomAccess, same error
// handling style, same bescomComponentRow/logAudit helpers already defined
// in this file).

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
      [req.params.id]
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

    // Note: serial_number is never referenced here -- editing a component
    // must never change its Serial Number, and it doesn't.
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
      ]
    );

    if (dmg !== undefined && dmg > prevDamaged) {
      await pool.query(
        `INSERT INTO damage_history (module, item_id, item_name, damaged_quantity, damage_reason, damage_description, recorded_by)
         VALUES ('bescom_component',$1,$2,$3,$4,$5,$6)`,
        [req.params.id, itemName, dmg - prevDamaged, damageReason || null, damageDescription || null, req.user ? req.user.email : null]
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
// create/update (requireBescomAccess) -- authenticateToken has already
// rejected anything but a token for saurav@robomanthan.com before this
// handler runs. Actually performs a SQL DELETE against Postgres, not a
// frontend-only row removal.
app.delete("/bescom/components/:id", authenticateToken, requireBescomAccess, async (req, res) => {
  try {
    const existing = await pool.query(
      `SELECT component_id AS "componentId", name, component_code AS "componentCode",
              serial_number AS "serialNumber"
       FROM bescom_components WHERE component_id = $1`,
      [req.params.id]
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

// ---------------------------------------------------------------------------
// Error handler
//
// Without this, an error thrown by the CORS origin check above (or any
// other route) falls through to Express's default HTML error page, which
// includes a full stack trace -- fine for local debugging, not something
// to expose from a deployed API. This keeps the same status codes/behavior,
// just returns clean JSON instead of leaking internals.
// ---------------------------------------------------------------------------
app.use((err, req, res, next) => {
  if (err && err.message === "Not allowed by CORS") {
    return res.status(403).json({ success: false, message: "Not allowed by CORS" });
  }
  console.error("Unhandled error:", err);
  if (res.headersSent) return next(err);
  res.status(500).json({ success: false, message: "Server error" });
});

// ---------------------------------------------------------------------------
// Start Server
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});