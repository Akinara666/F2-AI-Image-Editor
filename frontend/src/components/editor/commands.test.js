import { describe, expect, it, vi } from 'vitest';

vi.mock('fabric', () => ({
  fabric: {
    Image: {
      fromURL: vi.fn()
    }
  }
}));

import {
  clearEditorOverlays,
  deleteActiveObject,
  discardCandidate,
  resizeDocumentCanvas,
  resizeDocumentImage,
  setGenerationFrameRect,
  setGenerationFrameSize,
  undoEditorChange
} from './commands';

const buildFrameCommandMocks = () => ({
  genFrameVisual: { id: 'frame-visual' },
  fabricCanvas: { id: 'canvas', getObjects: vi.fn().mockReturnValue([]) },
  syncFrameVisualState: vi.fn(),
  setGenDimensions: vi.fn(),
  enforceCanvasLayerOrder: vi.fn(),
  syncCanvasInteractionMode: vi.fn(),
  markUndoDirty: vi.fn(),
  getUndoSnapshotParams: vi.fn().mockReturnValue({ id: 'undo' }),
  commitUndoSnapshot: vi.fn()
});

describe('editor commands', () => {
  it('discardCandidate очищает кандидат, маску и undo-состояние', () => {
    const candidate = { id: 'candidate-1' };
    const fabricCanvas = {
      remove: vi.fn(),
      discardActiveObject: vi.fn()
    };
    const setCandidateState = vi.fn();
    const setMaskOverlayVisibility = vi.fn();
    const syncCanvasInteractionMode = vi.fn();
    const getUndoSnapshotParams = vi.fn().mockReturnValue({ snapshot: 'payload' });
    const commitUndoSnapshot = vi.fn();

    discardCandidate({
      fabricCanvas,
      candidateRef: { current: candidate },
      setCandidateState,
      setMaskOverlayVisibility,
      syncCanvasInteractionMode,
      commitUndoSnapshot,
      getUndoSnapshotParams,
      genFrame: { id: 'frame' }
    });

    expect(fabricCanvas.remove).toHaveBeenCalledWith(candidate);
    expect(fabricCanvas.discardActiveObject).toHaveBeenCalled();
    expect(setCandidateState).toHaveBeenCalledWith(null, null);
    expect(setMaskOverlayVisibility).toHaveBeenCalledWith(true, fabricCanvas);
    expect(syncCanvasInteractionMode).toHaveBeenCalled();
    expect(commitUndoSnapshot).toHaveBeenCalledWith({ snapshot: 'payload' });
  });

  it('deleteActiveObject не удаляет сам generation frame', () => {
    const genFrame = { id: 'frame' };
    const fabricCanvas = {
      getActiveObject: vi.fn().mockReturnValue(genFrame),
      remove: vi.fn(),
      discardActiveObject: vi.fn()
    };
    const syncCandidateFromCanvas = vi.fn();
    const syncCanvasInteractionMode = vi.fn();
    const commitUndoSnapshot = vi.fn();

    deleteActiveObject({
      fabricCanvas,
      genFrame,
      syncCandidateFromCanvas,
      syncCanvasInteractionMode,
      commitUndoSnapshot,
      getUndoSnapshotParams: vi.fn()
    });

    expect(fabricCanvas.remove).not.toHaveBeenCalled();
    expect(syncCandidateFromCanvas).not.toHaveBeenCalled();
    expect(commitUndoSnapshot).not.toHaveBeenCalled();
  });

  it('deleteActiveObject удаляет активный объект и фиксирует undo-снимок', () => {
    const activeObject = { id: 'candidate' };
    const genFrame = { id: 'frame' };
    const fabricCanvas = {
      getActiveObject: vi.fn().mockReturnValue(activeObject),
      remove: vi.fn(),
      discardActiveObject: vi.fn()
    };
    const syncCandidateFromCanvas = vi.fn();
    const syncCanvasInteractionMode = vi.fn();
    const getUndoSnapshotParams = vi.fn().mockReturnValue({ id: 'undo-1' });
    const commitUndoSnapshot = vi.fn();

    deleteActiveObject({
      fabricCanvas,
      genFrame,
      syncCandidateFromCanvas,
      syncCanvasInteractionMode,
      commitUndoSnapshot,
      getUndoSnapshotParams
    });

    expect(fabricCanvas.remove).toHaveBeenCalledWith(activeObject);
    expect(fabricCanvas.discardActiveObject).toHaveBeenCalled();
    expect(syncCandidateFromCanvas).toHaveBeenCalledWith(fabricCanvas);
    expect(syncCanvasInteractionMode).toHaveBeenCalled();
    expect(commitUndoSnapshot).toHaveBeenCalledWith({ id: 'undo-1' });
  });

  it('setGenerationFrameSize обновляет геометрию рамки и синхронизирует редактор', () => {
    const genFrame = {
      set: vi.fn(),
      setCoords: vi.fn()
    };
    const genFrameVisual = { id: 'frame-visual' };
    const fabricCanvas = { id: 'canvas' };
    const syncFrameVisualState = vi.fn();
    const setGenDimensions = vi.fn();
    const enforceCanvasLayerOrder = vi.fn();
    const syncCanvasInteractionMode = vi.fn();
    const markUndoDirty = vi.fn();
    const getUndoSnapshotParams = vi.fn().mockReturnValue({ id: 'undo-2' });
    const commitUndoSnapshot = vi.fn();

    setGenerationFrameSize({
      width: 768,
      height: 512,
      genFrame,
      genFrameVisual,
      fabricCanvas,
      syncFrameVisualState,
      setGenDimensions,
      enforceCanvasLayerOrder,
      syncCanvasInteractionMode,
      markUndoDirty,
      commitUndoSnapshot,
      getUndoSnapshotParams
    });

    expect(genFrame.set).toHaveBeenCalledWith({ width: 768, height: 512, scaleX: 1, scaleY: 1 });
    expect(genFrame.setCoords).toHaveBeenCalled();
    expect(syncFrameVisualState).toHaveBeenCalledWith(genFrame);
    expect(markUndoDirty).toHaveBeenNthCalledWith(1, genFrame);
    expect(markUndoDirty).toHaveBeenNthCalledWith(2, genFrameVisual);
    expect(setGenDimensions).toHaveBeenCalledWith({ width: 768, height: 512 });
    expect(enforceCanvasLayerOrder).toHaveBeenCalledWith(fabricCanvas, genFrame);
    expect(syncCanvasInteractionMode).toHaveBeenCalled();
    expect(commitUndoSnapshot).toHaveBeenCalledWith({ id: 'undo-2' });
  });

  it('clearEditorOverlays удаляет только sketch и mask объекты', () => {
    const maskObject = { id: 'mask' };
    const sketchObject = { id: 'sketch' };
    const baseObject = { id: 'base' };
    const genFrame = { id: 'frame' };
    const fabricCanvas = {
      getObjects: vi.fn().mockReturnValue([maskObject, sketchObject, baseObject]),
      remove: vi.fn(),
      discardActiveObject: vi.fn()
    };
    const enforceCanvasLayerOrder = vi.fn();
    const syncCandidateFromCanvas = vi.fn();
    const syncMaskStateFromCanvas = vi.fn();
    const syncCanvasInteractionMode = vi.fn();
    const getUndoSnapshotParams = vi.fn().mockReturnValue({ id: 'undo-3' });
    const commitUndoSnapshot = vi.fn();

    clearEditorOverlays({
      fabricCanvas,
      genFrame,
      isMaskObject: (object) => object === maskObject,
      isSketchObject: (object) => object === sketchObject,
      enforceCanvasLayerOrder,
      syncCandidateFromCanvas,
      syncMaskStateFromCanvas,
      syncCanvasInteractionMode,
      commitUndoSnapshot,
      getUndoSnapshotParams
    });

    expect(fabricCanvas.remove).toHaveBeenCalledWith(maskObject);
    expect(fabricCanvas.remove).toHaveBeenCalledWith(sketchObject);
    expect(fabricCanvas.remove).not.toHaveBeenCalledWith(baseObject);
    expect(fabricCanvas.discardActiveObject).toHaveBeenCalled();
    expect(syncCandidateFromCanvas).toHaveBeenCalledWith(fabricCanvas);
    expect(syncMaskStateFromCanvas).toHaveBeenCalledWith(fabricCanvas);
    expect(syncCanvasInteractionMode).toHaveBeenCalled();
    expect(commitUndoSnapshot).toHaveBeenCalledWith({ id: 'undo-3' });
  });

  it('setGenerationFrameRect переносит рамку на область кадрирования', () => {
    const genFrame = { set: vi.fn(), setCoords: vi.fn() };
    const mocks = buildFrameCommandMocks();

    const applied = setGenerationFrameRect({
      rect: { left: 100.4, top: 50.6, width: 300.2, height: 200.8 },
      genFrame,
      ...mocks
    });

    expect(applied).toBe(true);
    expect(genFrame.set).toHaveBeenCalledWith({
      left: 100,
      top: 51,
      width: 300,
      height: 201,
      scaleX: 1,
      scaleY: 1
    });
    expect(mocks.setGenDimensions).toHaveBeenCalledWith({ width: 300, height: 201 });
    expect(mocks.commitUndoSnapshot).toHaveBeenCalledWith({ id: 'undo' });
  });

  it('setGenerationFrameRect без rect ничего не делает', () => {
    const genFrame = { set: vi.fn(), setCoords: vi.fn() };
    const mocks = buildFrameCommandMocks();

    expect(setGenerationFrameRect({ rect: null, genFrame, ...mocks })).toBe(false);
    expect(genFrame.set).not.toHaveBeenCalled();
    expect(mocks.commitUndoSnapshot).not.toHaveBeenCalled();
  });

  it('resizeDocumentImage масштабирует контент относительно начала рамки', () => {
    const genFrame = {
      left: 100,
      top: 100,
      width: 200,
      height: 100,
      scaleX: 1,
      scaleY: 1,
      set: vi.fn(),
      setCoords: vi.fn()
    };
    const layerObject = {
      left: 150,
      top: 100,
      scaleX: 1,
      scaleY: 2,
      set: vi.fn(),
      setCoords: vi.fn()
    };
    const overlayObject = { id: 'overlay' };
    const mocks = buildFrameCommandMocks();
    mocks.fabricCanvas.getObjects.mockReturnValue([layerObject, overlayObject]);

    const applied = resizeDocumentImage({
      width: 400,
      height: 300,
      genFrame,
      isLayerContentObject: (object) => object === layerObject,
      ...mocks
    });

    expect(applied).toBe(true);
    // factorX = 2, factorY = 3: смещение от рамки и масштаб умножаются.
    expect(layerObject.set).toHaveBeenCalledWith({
      left: 100 + (150 - 100) * 2,
      top: 100 + (100 - 100) * 3,
      scaleX: 2,
      scaleY: 6
    });
    expect(genFrame.set).toHaveBeenCalledWith({ width: 400, height: 300, scaleX: 1, scaleY: 1 });
    expect(mocks.markUndoDirty).toHaveBeenCalledWith(layerObject);
    expect(mocks.commitUndoSnapshot).toHaveBeenCalledTimes(1);
  });

  it('resizeDocumentCanvas сдвигает рамку по якорю, не трогая слои', () => {
    const genFrame = {
      left: 100,
      top: 100,
      width: 200,
      height: 200,
      scaleX: 1,
      scaleY: 1,
      set: vi.fn(),
      setCoords: vi.fn()
    };
    const mocks = buildFrameCommandMocks();

    const applied = resizeDocumentCanvas({
      width: 300,
      height: 100,
      anchorX: 1,
      anchorY: 0.5,
      genFrame,
      ...mocks
    });

    expect(applied).toBe(true);
    // anchorX=1: правый край на месте → left = 100 + (200-300)*1 = 0.
    // anchorY=0.5: центр на месте → top = 100 + (200-100)*0.5 = 150.
    expect(genFrame.set).toHaveBeenCalledWith({
      left: 0,
      top: 150,
      width: 300,
      height: 100,
      scaleX: 1,
      scaleY: 1
    });
    expect(mocks.setGenDimensions).toHaveBeenCalledWith({ width: 300, height: 100 });
  });

  it('undoEditorChange восстанавливает последний undo-снимок через enqueueCanvasMutation', async () => {
    const snapshot = { id: 'snapshot-1' };
    const restoreArgs = { id: 'restore-1' };
    const restoreUndoSnapshot = vi.fn();

    await undoEditorChange({
      fabricCanvas: { id: 'canvas' },
      genFrame: { id: 'frame' },
      enqueueCanvasMutation: async (callback) => callback(),
      popUndoSnapshot: vi.fn().mockReturnValue(snapshot),
      restoreUndoSnapshot,
      getUndoRestoreParams: vi.fn().mockReturnValue(restoreArgs),
      genFrameVisualRef: { current: { id: 'frame-visual' } }
    });

    expect(restoreUndoSnapshot).toHaveBeenCalledWith(restoreArgs);
  });
});
