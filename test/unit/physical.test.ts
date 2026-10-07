import { expect } from "chai";
import { checkPlacement, distance3d, positionsMatch } from "../../src/proof/physical";

describe("physical verification", () => {
  const target = { x: 1, y: 0, z: 0 };

  it("computes Euclidean distance in 3D", () => {
    expect(distance3d({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 })).to.equal(5);
    expect(distance3d({ x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 3 })).to.equal(0);
    expect(distance3d({ x: 0, y: 0, z: 0 }, { x: 1, y: 2, z: 2 })).to.equal(3);
  });

  it("object inside tolerance -> within", () => {
    const res = checkPlacement({ x: 1.01, y: 0.01, z: 0 }, target, 0.05);
    expect(res.within_tolerance).to.equal(true);
    expect(res.distance).to.be.closeTo(Math.SQRT2 * 0.01, 1e-12);
    expect(res.tolerance).to.equal(0.05);
  });

  it("object outside tolerance -> not within", () => {
    const res = checkPlacement({ x: 1.15, y: 0, z: 0 }, target, 0.05);
    expect(res.within_tolerance).to.equal(false);
    expect(res.distance).to.be.closeTo(0.15, 1e-12);
  });

  it("uses the full 3D distance (z offset counts)", () => {
    expect(checkPlacement({ x: 1, y: 0, z: 0.2 }, target, 0.05).within_tolerance).to.equal(false);
  });

  it("exact boundary counts as within (distance <= tolerance)", () => {
    expect(checkPlacement({ x: 3, y: 4, z: 0 }, { x: 0, y: 0, z: 0 }, 5).within_tolerance).to.equal(true);
    expect(checkPlacement({ x: 3, y: 4, z: 0 }, { x: 0, y: 0, z: 0 }, 4.999999).within_tolerance).to.equal(false);
    expect(checkPlacement(target, target, 0).within_tolerance).to.equal(true);
  });

  it("throws for invalid tolerances", () => {
    for (const tol of [-0.01, NaN, Infinity, -Infinity, "0.05" as unknown as number]) {
      expect(() => checkPlacement(target, target, tol), String(tol)).to.throw(RangeError);
    }
  });

  it("positionsMatch compares per axis with epsilon", () => {
    expect(positionsMatch({ x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 3 })).to.equal(true);
    expect(positionsMatch({ x: 0.1 + 0.2, y: 0, z: 0 }, { x: 0.3, y: 0, z: 0 })).to.equal(true);
    expect(positionsMatch({ x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 3.001 })).to.equal(false);
    expect(positionsMatch({ x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 3.001 }, 0.01)).to.equal(true);
  });
});
