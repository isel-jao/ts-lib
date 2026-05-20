import { describe, expect, it } from "vitest";
import { RingBuffer } from "./index";

describe("RingBuffer", () => {
  describe("constructor", () => {
    it("throws when capacity is 0", () => {
      expect(() => new RingBuffer(0)).toThrow("Capacity must be > 0");
    });

    it("throws when capacity is negative", () => {
      expect(() => new RingBuffer(-1)).toThrow("Capacity must be > 0");
    });

    it("starts empty", () => {
      const rb = new RingBuffer<number>(4);
      expect(rb.size).toBe(0);
      expect(rb.isEmpty).toBe(true);
      expect(rb.isFull).toBe(false);
    });
  });

  describe("push", () => {
    it("adds items and updates size", () => {
      const rb = new RingBuffer<number>(3);
      rb.push(1);
      rb.push(2);
      expect(rb.size).toBe(2);
    });

    it("returns undefined when not full", () => {
      const rb = new RingBuffer<number>(3);
      expect(rb.push(1)).toBeUndefined();
    });

    it("returns overwritten item when full", () => {
      const rb = new RingBuffer<number>(3);
      rb.push(1);
      rb.push(2);
      rb.push(3);
      expect(rb.push(4)).toBe(1);
    });

    it("overwrites oldest item when full", () => {
      const rb = new RingBuffer<number>(3);
      rb.push(1);
      rb.push(2);
      rb.push(3);
      rb.push(4);
      expect(rb.toArray()).toEqual([2, 3, 4]);
    });

    it("marks buffer as full at capacity", () => {
      const rb = new RingBuffer<number>(2);
      rb.push(1);
      rb.push(2);
      expect(rb.isFull).toBe(true);
    });
  });

  describe("shift", () => {
    it("returns undefined on empty buffer", () => {
      const rb = new RingBuffer<number>(3);
      expect(rb.shift()).toBeUndefined();
    });

    it("removes and returns the oldest item", () => {
      const rb = new RingBuffer<number>(3);
      rb.push(1);
      rb.push(2);
      rb.push(3);
      expect(rb.shift()).toBe(1);
      expect(rb.size).toBe(2);
    });

    it("drains the buffer in FIFO order", () => {
      const rb = new RingBuffer<number>(3);
      rb.push(10);
      rb.push(20);
      rb.push(30);
      expect([rb.shift(), rb.shift(), rb.shift()]).toEqual([10, 20, 30]);
      expect(rb.isEmpty).toBe(true);
    });
  });

  describe("pop", () => {
    it("returns undefined on empty buffer", () => {
      const rb = new RingBuffer<number>(3);
      expect(rb.pop()).toBeUndefined();
    });

    it("removes and returns the newest item", () => {
      const rb = new RingBuffer<number>(3);
      rb.push(1);
      rb.push(2);
      rb.push(3);
      expect(rb.pop()).toBe(3);
      expect(rb.size).toBe(2);
    });

    it("drains the buffer in LIFO order", () => {
      const rb = new RingBuffer<number>(3);
      rb.push(1);
      rb.push(2);
      rb.push(3);
      expect([rb.pop(), rb.pop(), rb.pop()]).toEqual([3, 2, 1]);
      expect(rb.isEmpty).toBe(true);
    });
  });

  describe("unshift", () => {
    it("adds an item to the front", () => {
      const rb = new RingBuffer<number>(3);
      rb.push(2);
      rb.push(3);
      rb.unshift(1);
      expect(rb.toArray()).toEqual([1, 2, 3]);
    });

    it("returns undefined when not full", () => {
      const rb = new RingBuffer<number>(3);
      expect(rb.unshift(1)).toBeUndefined();
    });

    it("returns overwritten tail item when full", () => {
      const rb = new RingBuffer<number>(3);
      rb.push(1);
      rb.push(2);
      rb.push(3);
      expect(rb.unshift(0)).toBe(3);
    });

    it("overwrites newest item when full", () => {
      const rb = new RingBuffer<number>(3);
      rb.push(1);
      rb.push(2);
      rb.push(3);
      rb.unshift(0);
      expect(rb.toArray()).toEqual([0, 1, 2]);
    });

    it("works correctly after wrap-around", () => {
      const rb = new RingBuffer<number>(3);
      rb.push(1);
      rb.push(2);
      rb.push(3);
      rb.shift();
      rb.unshift(0);
      expect(rb.toArray()).toEqual([0, 2, 3]);
    });
  });

  describe("at", () => {
    it("returns undefined for out-of-bounds index", () => {
      const rb = new RingBuffer<number>(3);
      rb.push(1);
      expect(rb.at(5)).toBeUndefined();
    });

    it("supports positive indices", () => {
      const rb = new RingBuffer<number>(4);
      rb.push(10);
      rb.push(20);
      rb.push(30);
      expect(rb.at(0)).toBe(10);
      expect(rb.at(1)).toBe(20);
      expect(rb.at(2)).toBe(30);
    });

    it("supports negative indices from the end", () => {
      const rb = new RingBuffer<number>(4);
      rb.push(10);
      rb.push(20);
      rb.push(30);
      expect(rb.at(-1)).toBe(30);
      expect(rb.at(-2)).toBe(20);
    });

    it("works correctly after wrap-around", () => {
      const rb = new RingBuffer<number>(3);
      rb.push(1);
      rb.push(2);
      rb.push(3);
      rb.push(4); // overwrites 1
      expect(rb.at(0)).toBe(2);
      expect(rb.at(1)).toBe(3);
      expect(rb.at(2)).toBe(4);
    });
  });

  describe("clear", () => {
    it("resets the buffer to empty", () => {
      const rb = new RingBuffer<number>(3);
      rb.push(1);
      rb.push(2);
      rb.clear();
      expect(rb.size).toBe(0);
      expect(rb.isEmpty).toBe(true);
      expect(rb.toArray()).toEqual([]);
    });

    it("allows reuse after clear", () => {
      const rb = new RingBuffer<number>(2);
      rb.push(1);
      rb.push(2);
      rb.clear();
      rb.push(3);
      expect(rb.toArray()).toEqual([3]);
    });
  });

  describe("toArray", () => {
    it("returns an empty array when empty", () => {
      const rb = new RingBuffer<number>(3);
      expect(rb.toArray()).toEqual([]);
    });

    it("returns items in FIFO order", () => {
      const rb = new RingBuffer<number>(4);
      rb.push(1);
      rb.push(2);
      rb.push(3);
      expect(rb.toArray()).toEqual([1, 2, 3]);
    });

    it("returns correct order after wrap-around and shifts", () => {
      const rb = new RingBuffer<number>(3);
      rb.push(1);
      rb.push(2);
      rb.push(3);
      rb.shift();
      rb.push(4);
      expect(rb.toArray()).toEqual([2, 3, 4]);
    });
  });

  describe("Symbol.iterator", () => {
    it("iterates in FIFO order", () => {
      const rb = new RingBuffer<number>(4);
      rb.push(5);
      rb.push(6);
      rb.push(7);
      expect([...rb]).toEqual([5, 6, 7]);
    });

    it("yields nothing for an empty buffer", () => {
      const rb = new RingBuffer<number>(4);
      expect([...rb]).toEqual([]);
    });
  });
});
