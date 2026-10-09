// seed-arango.js
import { Database } from "arangojs";
import dotenv from "dotenv";
dotenv.config();

const db = new Database({
  url: process.env.ARANGO_URL || "http://127.0.0.1:8529",
  databaseName: process.env.ARANGO_DB || "_system",
  auth: {
    username: process.env.ARANGO_USER || "root",
    password: process.env.ARANGO_PASSWORD || "",
  },
});

async function seed() {
  const entities = db.collection("entities");
  const connections = db.collection("connections");

  // Upsert sample vertices
  await entities.save({ _key: "gabby", name: "Gabby", type: "Person" }, { overwriteMode: "update" });
  await entities.save({ _key: "teddy", name: "Teddy", breed: "maltipoo", type: "Dog" }, { overwriteMode: "update" });
  await entities.save({ _key: "kiwi", name: "Kiwi", breed: "frug", type: "Dog" }, { overwriteMode: "update" });

  // Connect them
  await connections.save({ _from: "entities/teddy", _to: "entities/gabby", type: "OWNED_BY" }, { overwriteMode: "ignore" });
  await connections.save({ _from: "entities/kiwi", _to: "entities/gabby", type: "OWNED_BY" }, { overwriteMode: "ignore" });

  console.log("ArangoDB test data seeded.");
  process.exit(0);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});