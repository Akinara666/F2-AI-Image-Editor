import assert from "node:assert/strict";
import test from "node:test";
import { exportCanvasState, mergeCanvasLayers } from "../src/utils/canvasLogic.js";

class FakeObj {
  constructor(props = {}) {
    Object.assign(this, props);
    if (this.visible === undefined) this.visible = true;
  }

  set(patch) {
    Object.assign(this, patch);
  }

  bringToFront() {}
}

class FakeMaskGroup extends FakeObj {
  constructor(children) {
    super({ id: "maskGroup", opacity: 0.5, visible: true });
    this._children = children;
  }

  getObjects() {
    return this._children;
  }
}

class FakeCanvas {
  constructor(objects) {
    this._objects = objects;
    this.viewportTransform = [1, 0, 0, 1, 0, 0];
    this.backgroundColor = null;
    this.snapshots = [];
  }

  getObjects() {
    return this._objects;
  }

  setViewportTransform(vpt) {
    this.viewportTransform = [...vpt];
  }

  requestRenderAll() {}

  remove(obj) {
    this._objects = this._objects.filter((item) => item !== obj);
  }

  toDataURL() {
    const topVisible = this._objects
      .filter((o) => o.visible !== false)
      .map((o) => o.id || o.type || "obj");
    const maskGroup = this._objects.find((o) => o.id === "maskGroup");
    const maskChildrenVisible = maskGroup
      ? maskGroup.getObjects().filter((o) => o.visible !== false).map((o) => o.id)
      : [];
    this.snapshots.push({
      topVisible,
      maskChildrenVisible,
      backgroundColor: this.backgroundColor,
    });
    return "data:text/plain;base64,QQ==";
  }
}

function createFrame() {
  return new FakeObj({
    id: "frame",
    left: 0,
    top: 0,
    width: 64,
    height: 64,
    scaleX: 1,
    scaleY: 1,
    visible: true,
  });
}

test("exportCanvasState не экспортирует временную mask-only разметку", async () => {
  const tempMask = new FakeObj({
    id: "temp-mask",
    isMask: true,
    stroke: "red",
    opacity: 1,
    excludeFromExport: true,
  });
  const maskGroup = new FakeMaskGroup([tempMask]);
  const frame = createFrame();
  const base = new FakeObj({ id: "base-image", type: "image", visible: true });
  const canvas = new FakeCanvas([base, maskGroup, frame]);

  const result = await exportCanvasState(canvas, frame);

  assert.equal(result.mask, null);
  assert.equal(canvas.snapshots.length, 1);
});

test("exportCanvasState в mask-экспорте игнорирует overlay-элементы с excludeFromExport", async () => {
  const realMask = new FakeObj({
    id: "real-mask",
    isMask: true,
    stroke: "red",
    opacity: 0.7,
  });
  const tempMask = new FakeObj({
    id: "temp-mask",
    isMask: true,
    stroke: "red",
    opacity: 0.9,
    excludeFromExport: true,
  });
  const maskGroup = new FakeMaskGroup([realMask, tempMask]);
  const frame = createFrame();
  const base = new FakeObj({ id: "base-image", type: "image", visible: true });
  const canvas = new FakeCanvas([base, maskGroup, frame]);

  const result = await exportCanvasState(canvas, frame);

  assert.ok(result.mask instanceof Blob);
  assert.equal(canvas.snapshots.length, 2);
  assert.deepEqual(canvas.snapshots[1].maskChildrenVisible, ["real-mask"]);
  assert.equal(realMask.visible, true);
  assert.equal(tempMask.visible, true);
});

test("mergeCanvasLayers удаляет eraser-path и передает их в callback", () => {
  const frame = createFrame();
  const candidate = new FakeObj({ id: "candidate", isCandidate: true });
  const eraser1 = new FakeObj({ id: "eraser-1", isEraser: true });
  const eraser2 = new FakeObj({ id: "eraser-2", isEraser: true });
  const base = new FakeObj({ id: "base-image", type: "image" });
  const canvas = new FakeCanvas([base, eraser1, candidate, eraser2, frame]);

  let removed = null;
  mergeCanvasLayers(canvas, candidate, frame, (erasers) => {
    removed = erasers;
  });

  assert.equal(candidate.isCandidate, false);
  assert.equal(candidate.lockMovementX, true);
  assert.equal(canvas.getObjects().includes(eraser1), false);
  assert.equal(canvas.getObjects().includes(eraser2), false);
  assert.deepEqual(removed, [eraser1, eraser2]);
});
