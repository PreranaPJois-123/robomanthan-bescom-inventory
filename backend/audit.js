// audit.js
//
// Small helper for writing to the immutable audit_logs table.
// Never call UPDATE/DELETE against audit_logs anywhere in the app --
// entries are append-only by design (spec: "Never delete audit logs").
//
// Usage:
//   const { logAudit } = require("./audit");
//   await logAudit(pool, {
//     actorEmail: req.user?.email,
//     actorRole: req.user?.role,
//     action: "COMPONENT_USED",
//     description: `${employeeName} used ${quantity} ${componentName}`,
//     metadata: { productId, quantity, issueId },
//   });
//
// Logging failures are swallowed (logged to console) so that a problem
// writing an audit row never blocks the underlying business operation
// (stock update, issue, return, etc).

async function logAudit(pool, { actorEmail, actorRole, action, description, metadata } = {}) {
  try {
    await pool.query(
      `
      INSERT INTO audit_logs (actor_email, actor_role, action, description, metadata)
      VALUES ($1, $2, $3, $4, $5)
      `,
      [
        actorEmail || null,
        actorRole || null,
        action || "UNKNOWN",
        description || "",
        metadata ? JSON.stringify(metadata) : null,
      ],
    );
  } catch (err) {
    // Never let audit logging break the calling request
    console.error("Failed to write audit log:", err.message);
  }
}

module.exports = { logAudit };
