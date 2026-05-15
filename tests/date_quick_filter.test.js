import assert from "node:assert/strict";
import test from "node:test";

function createDayjsMock(todayIso) {
  class MockDayjs {
    constructor(input = todayIso) {
      if (input instanceof MockDayjs) {
        this.date = new Date(input.date);
      } else if (input instanceof Date) {
        this.date = new Date(input);
      } else {
        this.date = new Date(`${input}T00:00:00Z`);
      }
    }

    subtract(amount, unit) {
      const next = new Date(this.date);
      if (unit === "day") {
        next.setUTCDate(next.getUTCDate() - amount);
      } else if (unit === "month") {
        next.setUTCMonth(next.getUTCMonth() - amount);
      } else if (unit === "year") {
        next.setUTCFullYear(next.getUTCFullYear() - amount);
      }
      return new MockDayjs(next);
    }

    format(pattern) {
      if (pattern !== "YYYY-MM-DD") {
        throw new Error(`Unsupported mock dayjs format: ${pattern}`);
      }
      return this.date.toISOString().slice(0, 10);
    }

    isValid() {
      return !Number.isNaN(this.date.getTime());
    }

    startOf(unit) {
      if (unit !== "day") {
        throw new Error(`Unsupported mock dayjs startOf unit: ${unit}`);
      }
      return new MockDayjs(this.format("YYYY-MM-DD"));
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
  globalThis.dayjs = createDayjsMock("2026-05-14");
  installStorageMock();
});

test.after(() => {
  globalThis.dayjs = undefined;
  globalThis.localStorage = undefined;
});

test("yesterday quick filter returns a since-yesterday date range", async () => {
  const { DateUtils } = await import("../static/js/modules/utils/date-utils.js");

  assert.deepEqual(await DateUtils.getDateRangePreset("yesterday"), {
    startDate: "2026-05-13",
    endDate: "2026-05-14",
  });
});

test("since-yesterday range still renders as the yesterday preset", async () => {
  const { default: dateManager } = await import(
    "../static/js/modules/ui/date-manager.js"
  );

  assert.equal(dateManager.detectPreset("2026-05-13", "2026-05-14"), "yesterday");
});
