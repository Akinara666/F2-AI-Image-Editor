import { fabric } from 'fabric';

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

    const isDrawing = !['none', 'hand'].includes(brushMode);
    canvas.isDrawingMode = isDrawing;
    canvas.selection = brushMode === 'none';
    canvas.defaultCursor = brushMode === 'hand' ? 'grab' : 'default';

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
        const interactive = brushMode === 'none' && (isFrame || isCurrentCandidate || isBaseRaster);

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
                lockMovementX: !interactive,
                lockMovementY: !interactive,
                lockScalingX: !interactive,
                lockScalingY: !interactive,
                lockRotation: true,
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
    applyEraserPathToCanvas
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
