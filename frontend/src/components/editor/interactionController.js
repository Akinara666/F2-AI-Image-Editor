import { fabric } from 'fabric';
import { TOOL_MODES, isDrawingToolMode, getCursorForToolMode } from './toolModes';
import {
    getObjectWorldBounds,
    intersectsBrushCircle,
    worldPointToLocal,
    cloneCanvasElement,
    ensureWritableCanvasElement
} from './rasterUtils';

const CLONE_STAMP_MODE = TOOL_MODES.CLONE_STAMP;
const SPOT_HEAL_MODE = TOOL_MODES.SPOT_HEAL;

export const applyCanvasInteractionMode = ({
    canvas,
    frameObject,
    currentCandidate,
    brushMode,
    brushColor,
    brushSize,
    isBaseRasterObject,
    isCandidateObject,
    enforceCanvasLayerOrder
}) => {
    if (!canvas || !frameObject) return;

    const isDrawing = isDrawingToolMode(brushMode);
    canvas.isDrawingMode = isDrawing;
    canvas.selection = brushMode === 'none';
    canvas.defaultCursor = getCursorForToolMode(brushMode);

    if (brushMode !== 'none' && canvas.getActiveObject()) {
        canvas.discardActiveObject();
    }

    if (isDrawing) {
        const brush = new fabric.PencilBrush(canvas);
        brush.width = brushMode === 'eraser' ? brushSize * 2 : brushSize;
        brush.color = brushMode === 'mask'
            ? 'rgba(255, 0, 0, 1.0)'
            : (brushMode === 'eraser' ? 'rgba(0, 0, 0, 1.0)' : brushColor);
        canvas.freeDrawingBrush = brush;
    }

    canvas.getObjects().forEach((object) => {
        const isFrame = object === frameObject;
        const isBaseRaster = isBaseRasterObject(object, frameObject);
        const isCurrentCandidate = object === currentCandidate || isCandidateObject(object, frameObject);
        const isLayerLocked = object?.editorLayerLocked === true;
        const interactive = brushMode === 'none' && (isFrame || ((isCurrentCandidate || isBaseRaster) && !isLayerLocked));

        object.selectable = interactive;
        object.evented = interactive;
        object.hasControls = interactive;

        if (isFrame) {
            object.lockRotation = true;
            object.hoverCursor = interactive ? 'move' : 'default';
        }

        if (isCurrentCandidate || isBaseRaster) {
            object.set({
                selectable: interactive,
                evented: interactive,
                hasControls: interactive,
                lockMovementX: !interactive || isLayerLocked,
                lockMovementY: !interactive || isLayerLocked,
                lockScalingX: !interactive || isLayerLocked,
                lockScalingY: !interactive || isLayerLocked,
                lockRotation: !interactive || isLayerLocked,
                hoverCursor: interactive ? 'move' : 'default'
            });
        }
    });

    enforceCanvasLayerOrder(canvas, frameObject);
    canvas.requestRenderAll();
};

export const setupPathCreationHandling = ({
    canvas,
    frameObject,
    brushModeRef,
    candidateRef,
    maskOverlayVisibleRef,
    canvasObjectRoles,
    enforceCanvasLayerOrder,
    syncMaskStateFromCanvas,
    syncCandidateFromCanvas,
    syncCanvasInteractionMode,
    markUndoDirty,
    commitUndoSnapshot,
    getUndoSnapshotParams,
    getMaskGroupFromCanvas,
    enqueueCanvasMutation,
    applyEraserPathToCanvas,
    onMaskChanged
}) => {
    if (!canvas || !frameObject) {
        return () => {};
    }

    const handlePathCreated = (event) => {
        const path = event.path;
        const currentMode = brushModeRef.current;
        if (!path) return;

        if (currentMode === 'mask') {
            path.set({
                editorRole: canvasObjectRoles.MASK,
                isMask: true,
                selectable: false,
                evented: false,
                opacity: 1.0
            });

            let maskGroup = getMaskGroupFromCanvas(canvas);
            if (!maskGroup) {
                maskGroup = new fabric.Group([], {
                    id: 'maskGroup',
                    editorRole: canvasObjectRoles.MASK,
                    selectable: false,
                    evented: false,
                    opacity: 0.5,
                    objectCaching: true
                });
                canvas.add(maskGroup);
            }

            maskGroup.addWithUpdate(path);
            markUndoDirty(maskGroup);
            canvas.remove(path);
            if (candidateRef.current && !maskOverlayVisibleRef.current) {
                markUndoDirty(maskGroup);
                maskGroup.set({ visible: false });
            }
            enforceCanvasLayerOrder(canvas, frameObject);
            syncMaskStateFromCanvas(canvas);
            onMaskChanged?.(canvas);
            canvas.requestRenderAll();
            commitUndoSnapshot(getUndoSnapshotParams(canvas, frameObject));
            return;
        }

        if (currentMode === 'eraser') {
            path.set({
                editorRole: 'eraser',
                isEraser: true,
                globalCompositeOperation: 'destination-out',
                objectCaching: false,
                selectable: false,
                evented: false
            });

            enqueueCanvasMutation(async () => {
                const result = await applyEraserPathToCanvas(canvas, path, frameObject);
                if (result.removedObjects.length > 0 || result.addedObjects.length > 0) {
                    commitUndoSnapshot(getUndoSnapshotParams(canvas, frameObject));
                }
                syncCandidateFromCanvas(canvas);
                syncCanvasInteractionMode();
            });
            return;
        }

        path.set({
            editorRole: canvasObjectRoles.SKETCH,
            isMask: false,
            selectable: false,
            evented: false
        });
        enforceCanvasLayerOrder(canvas, frameObject);
        canvas.requestRenderAll();
        commitUndoSnapshot(getUndoSnapshotParams(canvas, frameObject));
    };

    canvas.on('path:created', handlePathCreated);

    return () => {
        canvas.off('path:created', handlePathCreated);
    };
};

export const setupSpotHealInstantHandling = ({
    canvas,
    brushModeRef,
    brushSizeRef,
    onSpotHealPoint
}) => {
    if (!canvas) {
        return () => {};
    }

    const handleMouseDown = (event) => {
        if (brushModeRef.current !== SPOT_HEAL_MODE) {
            return;
        }
        if (event.e.button !== 0) {
            return;
        }

        const pointer = canvas.getPointer(event.e);
        if (!pointer) {
            return;
        }

        event.e.preventDefault();
        event.e.stopPropagation();
        const radius = Math.max(4, Number(brushSizeRef.current || 1) / 2);
        onSpotHealPoint?.({
            x: pointer.x,
            y: pointer.y,
            radius
        });
    };

    canvas.on('mouse:down', handleMouseDown);

    return () => {
        canvas.off('mouse:down', handleMouseDown);
    };
};

export const setupCloneStampHandling = ({
    canvas,
    frameObject,
    brushModeRef,
    brushSizeRef,
    candidateRef,
    isBaseRasterObject,
    isCandidateObject,
    markUndoDirty,
    commitUndoSnapshot,
    getUndoSnapshotParams
}) => {
    if (!canvas || !frameObject) {
        return () => {};
    }

    let sourcePoint = null;
    let isStamping = false;
    let strokeOffset = { x: 0, y: 0 };
    let strokeChanged = false;
    let touchedObjects = new Set();
    let sourceSnapshots = new WeakMap();

    const getEditableRasterObjects = () => {
        const allRasterObjects = canvas.getObjects().filter((object) => (
            object.visible !== false
            && (isCandidateObject(object, frameObject) || isBaseRasterObject(object, frameObject))
        ));
        const candidateObject = candidateRef.current;
        if (candidateObject && allRasterObjects.includes(candidateObject)) {
            return [candidateObject];
        }
        return allRasterObjects;
    };

    const applyStampAt = (targetPoint) => {
        const radius = Math.max(1, Number(brushSizeRef.current || 1) / 2);
        const sourceSamplePoint = {
            x: targetPoint.x + strokeOffset.x,
            y: targetPoint.y + strokeOffset.y
        };
        const editableObjects = getEditableRasterObjects();

        editableObjects.forEach((object) => {
            const bounds = getObjectWorldBounds(object);
            if (!intersectsBrushCircle(targetPoint, radius, bounds)) {
                return;
            }

            const writableElement = ensureWritableCanvasElement(object);
            if (!writableElement) {
                return;
            }

            if (!sourceSnapshots.has(object)) {
                sourceSnapshots.set(object, cloneCanvasElement(writableElement));
            }

            const snapshot = sourceSnapshots.get(object);
            const destination = worldPointToLocal(object, targetPoint);
            const source = worldPointToLocal(object, sourceSamplePoint);
            const radiusX = radius / (object.scaleX || 1);
            const radiusY = radius / (object.scaleY || 1);
            const context = writableElement.getContext('2d');
            if (!context) {
                return;
            }

            if (!touchedObjects.has(object)) {
                markUndoDirty(object);
                touchedObjects.add(object);
            }

            context.save();
            context.beginPath();
            context.ellipse(
                destination.x,
                destination.y,
                Math.max(0.5, radiusX),
                Math.max(0.5, radiusY),
                0,
                0,
                Math.PI * 2
            );
            context.closePath();
            context.clip();
            context.drawImage(
                snapshot,
                source.x - radiusX,
                source.y - radiusY,
                radiusX * 2,
                radiusY * 2,
                destination.x - radiusX,
                destination.y - radiusY,
                radiusX * 2,
                radiusY * 2
            );
            context.restore();

            object.set({
                dirty: true,
                objectCaching: false
            });
            object.setCoords();
            strokeChanged = true;
        });

        if (strokeChanged) {
            canvas.requestRenderAll();
        }
    };

    const handleMouseDown = (event) => {
        if (brushModeRef.current !== CLONE_STAMP_MODE) {
            return;
        }

        const pointer = canvas.getPointer(event.e);
        if (!pointer) {
            return;
        }

        if (event.e.altKey) {
            sourcePoint = { x: pointer.x, y: pointer.y };
            event.e.preventDefault();
            event.e.stopPropagation();
            return;
        }

        if (!sourcePoint) {
            sourcePoint = { x: pointer.x, y: pointer.y };
            return;
        }

        isStamping = true;
        strokeChanged = false;
        touchedObjects = new Set();
        sourceSnapshots = new WeakMap();
        strokeOffset = {
            x: sourcePoint.x - pointer.x,
            y: sourcePoint.y - pointer.y
        };
        applyStampAt(pointer);
    };

    const handleMouseMove = (event) => {
        if (!isStamping || brushModeRef.current !== CLONE_STAMP_MODE) {
            return;
        }
        const pointer = canvas.getPointer(event.e);
        if (!pointer) {
            return;
        }
        applyStampAt(pointer);
    };

    const handleMouseUp = () => {
        if (!isStamping) {
            return;
        }
        isStamping = false;

        if (strokeChanged) {
            commitUndoSnapshot(getUndoSnapshotParams(canvas, frameObject));
        }

        touchedObjects = new Set();
        sourceSnapshots = new WeakMap();
        strokeChanged = false;
    };

    canvas.on('mouse:down', handleMouseDown);
    canvas.on('mouse:move', handleMouseMove);
    canvas.on('mouse:up', handleMouseUp);

    return () => {
        canvas.off('mouse:down', handleMouseDown);
        canvas.off('mouse:move', handleMouseMove);
        canvas.off('mouse:up', handleMouseUp);
    };
};
