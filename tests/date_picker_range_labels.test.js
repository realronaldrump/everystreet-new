import assert from "node:assert/strict";
import test from "node:test";

/**
 * Mirrors real dayjs closely enough for the date manager: bare "YYYY-MM-DD"
 * strings parse to *local* midnight, so the local Date getters the trigger
 * label relies on are timezone-stable.
 */
function createLocalDayjsMock(todayIso) {
  class MockDayjs {
    constructor(input = todayIso) {
      if (input instanceof MockDayjs) {
        this.date = new Date(input.date);
      } else if (input instanceof Date) {
        this.date = new Date(input);
      } else if (typeof input === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input)) {
        const [year, month, day] = input.split("-").map(Number);
        this.date = new Date(year, month - 1, day);
      } else {
        this.date = new Date(input);
      }
    }

    startOf(unit) {
      if (unit !== "day") {
        throw new Error(`Unsupported mock dayjs startOf unit: ${unit}`);
      }
      const next = new Date(this.date);
      next.setHours(0, 0, 0, 0);
      return new MockDayjs(next);
    }

    subtract(amount, unit) {
      const next = new Date(this.date);
      if (unit === "day") {
        next.setDate(next.getDate() - amount);
      } else if (unit === "month") {
        next.setMonth(next.getMonth() - amount);
      } else if (unit === "year") {
        next.setFullYear(next.getFullYear() - amount);
      }
      return new MockDayjs(next);
    }

    format(pattern) {
      if (pattern !== "YYYY-MM-DD") {
        throw new Error(`Unsupported mock dayjs format: ${pattern}`);
      }
      const pad = (value) => String(value).padStart(2, "0");
      return `${this.date.getFullYear()}-${pad(this.date.getMonth() + 1)}-${pad(
        this.date.getDate()
      )}`;
    }

    isValid() {
      return !Number.isNaN(this.date.getTime());
    }

    toDate() {
      return new Date(this.date);
    }
  }

  return (input) => new MockDayjs(input);
}

function installStorageMock() {
  const storage = new Map();
  globalThis.localStorage = {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      storage.set(key, String(value));
    },
    removeItem(key) {
      storage.delete(key);
    },
    key(index) {
      return Array.from(storage.keys())[index] ?? null;
    },
    get length() {
      return storage.size;
    },
  };
}

test.before(() => {
  globalThis.dayjs = createLocalDayjsMock("2026-07-29");
  installStorageMock();
});

test.after(() => {
  globalThis.dayjs = undefined;
  globalThis.localStorage = undefined;
});

async function loadDateManager() {
  const { default: dateManager } = await import(
    "../static/js/modules/ui/date-manager.js"
  );
  return dateManager;
}

test("range day count is inclusive of both endpoints", async () => {
  const dateManager = await loadDateManager();

  assert.equal(dateManager.countDays("2026-07-25", "2026-07-25"), 1);
  assert.equal(dateManager.countDays("2026-07-06", "2026-07-15"), 10);
  assert.equal(dateManager.countDays("2026-07-01", "2026-07-31"), 31);
  // Spans a US daylight-saving transition: still whole days, never 30.96.
  assert.equal(dateManager.countDays("2026-03-01", "2026-03-31"), 31);
  assert.equal(dateManager.countDays("", "2026-07-15"), 0);
});

test("trigger label stays compact so it fits a phone header", async () => {
  const dateManager = await loadDateManager();

  // Single day in the current year drops the year entirely.
  assert.equal(dateManager.formatTriggerRange("2026-07-25", "2026-07-25"), "Jul 25");
  // Same month: only the end day needs repeating.
  assert.equal(
    dateManager.formatTriggerRange("2026-07-06", "2026-07-15"),
    "Jul 6 – 15"
  );
  // Different months, same (current) year: still no years.
  assert.equal(
    dateManager.formatTriggerRange("2026-01-03", "2026-07-15"),
    "Jan 3 – Jul 15"
  );
  // Once a year other than the current one is involved, it is spelled out —
  // but only once when both ends share it.
  assert.equal(
    dateManager.formatTriggerRange("2025-07-25", "2025-07-25"),
    "Jul 25, 2025"
  );
  assert.equal(
    dateManager.formatTriggerRange("2025-07-01", "2025-07-31"),
    "Jul 1 – 31, 2025"
  );
  assert.equal(
    dateManager.formatTriggerRange("2025-01-03", "2025-07-15"),
    "Jan 3 – Jul 15, 2025"
  );
  assert.equal(
    dateManager.formatTriggerRange("2025-01-03", "2026-07-15"),
    "Jan 3, 2025 – Jul 15, 2026"
  );
});
