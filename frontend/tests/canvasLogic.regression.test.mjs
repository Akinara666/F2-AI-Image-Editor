import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fabric } from "fabric";
import { exportCanvasState } from "../src/utils/canvasLogic.js";

const renderSnapshots = [];
const originalCreateCanvasElement = fabric.util.createCanvasElement;

fabric.util.createCanvasElement = () => {
  const ctx = {
    fillStyle: "",
    renderedIds: [],
    save() {},
    restore() {},
    translate() {},
    fillRect() {},
    getImageData() {
      return { data: new Uint8ClampedArray([0, 0, 0, 255]) };
    },
    __renderId(id) {
      this.renderedIds.push(id);
    },
  };
  return {
    width: 0,
    height: 0,
    getContext() {
      return ctx;
    },
    toBlob(callback, type) {
      renderSnapshots.push([...ctx.renderedIds]);
      callback(new Blob(["x"], { type: type || "image/png" }));
    },
  };
};

class FakeObj {
  constructor(props = {}) {
    Object.assign(this, props);
    if (this.visible === undefined) this.visible = true;
  }

  set(patch) {
    Object.assign(this, patch);
  }

  bringToFront() {}

  render(ctx) {
    if (this.visible !== false) {
      ctx.__renderId(this.id || "obj");
    }
  }

  clone(cb) {
    cb(new FakeObj({ ...this }));
  }
}

class FakeMaskGroup extends FakeObj {
  constructor(children) {
    super({ id: "maskGroup", opacity: 0.5, visible: true });
    this._children = children;
  }

  getObjects() {
    return this._children;
  }

  clone(cb) {
    const clonedChildren = this._children.map((child) => new FakeObj({ ...child }));
    cb(new FakeMaskGroup(clonedChildren));
  }

  render(ctx) {
    if (this.visible === false) return;
    this._children.forEach((child) => {
      if (child.visible !== false) {
        child.render(ctx);
      }
    });
  }
}

class FakeCanvas {
  constructor(objects) {
    this._objects = objects;
  }

  getObjects() {
    return this._objects;
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
    editorRole: "frame",
  });
}

test("exportCanvasState не создает mask blob если есть только временная mask-only разметка", async () => {
  renderSnapshots.length = 0;
  const tempMask = new FakeObj({
    id: "temp-mask",
    isMask: true,
    stroke: "red",
    opacity: 1,
    excludeFromExport: true,
  });
  const maskGroup = new FakeMaskGroup([tempMask]);
  const frame = createFrame();
  const base = new FakeObj({ id: "base-image", editorRole: "base", visible: true });
  const canvas = new FakeCanvas([base, maskGroup, frame]);

  const result = await exportCanvasState(canvas, frame);

  assert.equal(result.mask, null);
  assert.equal(renderSnapshots.length, 1);
});

test("exportCanvasState в mask-экспорте исключает overlay элементы", async () => {
  renderSnapshots.length = 0;
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
  const base = new FakeObj({ id: "base-image", editorRole: "base", visible: true });
  const canvas = new FakeCanvas([base, maskGroup, frame]);

  const result = await exportCanvasState(canvas, frame);

  assert.ok(result.mask instanceof Blob);
  assert.equal(renderSnapshots.length, 2);
  assert.deepEqual(renderSnapshots[1], ["real-mask"]);
  assert.equal(realMask.visible, true);
  assert.equal(tempMask.visible, true);
});

after(() => {
  fabric.util.createCanvasElement = originalCreateCanvasElement;
});
