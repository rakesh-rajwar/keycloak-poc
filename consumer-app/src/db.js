import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = process.env.DB_PATH || "/data/consumer-app-db.json";

const EMPTY = {
  customers: [],
  workspaces: [],
  users: [],
  userWorkspaces: [],
  webhookEvents: [],
};

function load() {
  if (!existsSync(DB_PATH)) return structuredClone(EMPTY);
  try {
    return { ...structuredClone(EMPTY), ...JSON.parse(readFileSync(DB_PATH, "utf8")) };
  } catch {
    return structuredClone(EMPTY);
  }
}

let state = load();

function persist() {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  writeFileSync(DB_PATH, JSON.stringify(state, null, 2));
}

function upsert(table, keyField, record) {
  const rows = state[table];
  const idx = rows.findIndex((r) => r[keyField] === record[keyField]);
  if (idx === -1) rows.push(record);
  else rows[idx] = { ...rows[idx], ...record };
  persist();
  return record;
}

function remove(table, keyField, keyValue) {
  state[table] = state[table].filter((r) => r[keyField] !== keyValue);
  persist();
}

function all(table) {
  return state[table];
}

function find(table, keyField, keyValue) {
  return state[table].find((r) => r[keyField] === keyValue);
}

function appendEvent(record) {
  state.webhookEvents.unshift(record);
  state.webhookEvents = state.webhookEvents.slice(0, 200);
  persist();
}

export const db = { upsert, remove, all, find, appendEvent };
