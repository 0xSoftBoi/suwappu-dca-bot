import { describe, it, expect } from "bun:test";

describe("smoke tests", () => {
  it("should have SUWAPPU_API_KEY requirement", () => {
    expect(typeof process.env.SUWAPPU_API_KEY).toBe("string");
  });
});
