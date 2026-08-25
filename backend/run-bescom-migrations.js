require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const client = new Client({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false },
});

const migrations = [
  "20260811_bescom_module.sql",
  "20260811b_bescom_deployments.sql",
  "20260811c_bescom_relax_required_fields.sql",
  "20260812_bescom_iami_and_partial_save.sql",
  "20260826_component_serial_number.sql",
  // Drops every non-BESCOM ("SmartStock") table. Run this only after you
  // are sure you no longer need the old product/issue/customer data --
  // see the comment at the top of the migration file for details.
  "20260825_bescom_only_cleanup.sql",
];

async function run() {
  try {
    await client.connect();
    console.log("✅ Connected to Neon");

    for (const file of migrations) {
      console.log(`\n▶ Running ${file}`);

      const filePath = path.join(__dirname, "migrations", file);
      const sql = fs.readFileSync(filePath, "utf8");

      await client.query(sql);

      console.log(`✅ ${file} completed`);
    }

    const result = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'bescom_kits',
          'bescom_components',
          'bescom_deployments'
        )
      ORDER BY table_name;
    `);

    console.log("\n📋 BESCOM tables found:");
    console.table(result.rows);

    await client.end();
    console.log("\n🎉 BESCOM migrations completed successfully!");
  } catch (error) {
    console.error("\n❌ Migration failed:");
    console.error(error);
    await client.end().catch(() => {});
    process.exit(1);
  }
}

run();
