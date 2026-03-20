import { fabric } from 'fabric';
import { CANVAS_DEFAULTS, CANVAS_OBJECT_ROLES, resolveApiUrl } from '../../constants';
import { blobToDataURL } from './helpers';

export const discardCandidate = ({
    fabricCanvas,
    candidateRef,
    setCandidateState,
    setMaskOverlayVisibility,
    syncCanvasInteractionMode,
    commitUndoSnapshot,
    getUndoSnapshotParams,
    genFrame
}) => {
    if (!fabricCanvas || !candidateRef.current) return;

    fabricCanvas.remove(candidateRef.current);
    fabricCanvas.discardActiveObject();
    setCandidateState(null, null);
    setMaskOverlayVisibility(true, fabricCanvas);
    syncCanvasInteractionMode();
    commitUndoSnapshot(getUndoSnapshotParams(fabricCanvas, genFrame));
};

export const acceptCandidate = async ({
    fabricCanvas,
    genFrame,
    candidateRef,
    enqueueCanvasMutation,
    bakeCandidateIntoCanvas,
    getMaskGroupFromCanvas,
    setCandidateState,
    syncMaskStateFromCanvas,
    syncCanvasInteractionMode,
    commitUndoSnapshot,
    getUndoSnapshotParams
}) => {
    if (!fabricCanvas || !genFrame || !candidateRef.current) return;

    await enqueueCanvasMutation(async () => {
        await bakeCandidateIntoCanvas(fabricCanvas, candidateRef.current, genFrame);
        const maskGroup = getMaskGroupFromCanvas(fabricCanvas);
        if (maskGroup) {
            fabricCanvas.remove(maskGroup);
        }
        setCandidateState(null, null);
        syncMaskStateFromCanvas(fabricCanvas);
        syncCanvasInteractionMode();
        commitUndoSnapshot(getUndoSnapshotParams(fabricCanvas, genFrame));
    });
};

export const undoEditorChange = async ({
    fabricCanvas,
    genFrame,
    enqueueCanvasMutation,
    popUndoSnapshot,
    restoreUndoSnapshot,
    getUndoRestoreParams,
    genFrameVisualRef
}) => {
    if (!fabricCanvas || !genFrame) return;

    await enqueueCanvasMutation(async () => {
        const snapshot = popUndoSnapshot();
        if (!snapshot) {
            return;
        }

        await restoreUndoSnapshot(getUndoRestoreParams(snapshot, fabricCanvas, genFrame, genFrameVisualRef.current));
    });
};

export const deleteActiveObject = ({
    fabricCanvas,
    genFrame,
    syncCandidateFromCanvas,
    syncCanvasInteractionMode,
    commitUndoSnapshot,
    getUndoSnapshotParams
}) => {
    if (!fabricCanvas || !genFrame) return;

    const activeObject = fabricCanvas.getActiveObject();
    if (!activeObject || activeObject === genFrame) return;

    fabricCanvas.remove(activeObject);
    fabricCanvas.discardActiveObject();
    syncCandidateFromCanvas(fabricCanvas);
    syncCanvasInteractionMode();
    commitUndoSnapshot(getUndoSnapshotParams(fabricCanvas, genFrame));
};

export const setGenerationFrameSize = ({
    width,
    height,
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
}) => {
    if (!genFrame || !fabricCanvas) return;

    genFrame.set({ width, height, scaleX: 1, scaleY: 1 });
    genFrame.setCoords();
    syncFrameVisualState(genFrame);
    markUndoDirty(genFrame);
    markUndoDirty(genFrameVisual);
    setGenDimensions({ width, height });
    enforceCanvasLayerOrder(fabricCanvas, genFrame);
    syncCanvasInteractionMode();
    commitUndoSnapshot(getUndoSnapshotParams(fabricCanvas, genFrame));
};

export const addGeneratedImage = async ({
    url,
    fabricCanvas,
    genFrame,
    candidateRef,
    setCandidateState,
    getMaskGroupFromCanvas,
    enforceCanvasLayerOrder,
    syncMaskStateFromCanvas,
    syncCanvasInteractionMode,
    markUndoDirty,
    commitUndoSnapshot,
    getUndoSnapshotParams
}) => {
    if (!fabricCanvas || !genFrame) return;

    if (candidateRef.current) {
        fabricCanvas.remove(candidateRef.current);
        setCandidateState(null, null);
    }

    const response = await fetch(resolveApiUrl(url), { mode: 'cors' });
    if (!response.ok) {
        throw new Error(`Failed to load generated image: ${response.status}`);
    }

    const imageBlob = await response.blob();
    const dataUrl = await blobToDataURL(imageBlob);

    await new Promise((resolve, reject) => {
        fabric.Image.fromURL(dataUrl, (image) => {
            if (!image) {
                reject(new Error('Failed to decode generated image.'));
                return;
            }

            const displayWidth = genFrame.width * genFrame.scaleX;
            const displayHeight = genFrame.height * genFrame.scaleY;

            image.set({
                left: genFrame.left,
                top: genFrame.top,
                originX: 'left',
                originY: 'top',
                scaleX: displayWidth / image.width,
                scaleY: displayHeight / image.height,
                objectCaching: false,
                noScaleCache: false,
                selectable: true,
                evented: true,
                hasControls: true,
                lockRotation: true,
                isCandidate: true,
                editorRole: CANVAS_OBJECT_ROLES.CANDIDATE,
                candidateSourceUrl: url,
                stroke: CANVAS_DEFAULTS.CANDIDATE_BORDER_COLOR,
                strokeWidth: 4,
                hoverCursor: 'move'
            });

            image.setCoords();
            fabricCanvas.add(image);
            fabricCanvas.setActiveObject(image);
            const maskGroup = getMaskGroupFromCanvas(fabricCanvas);
            if (maskGroup) {
                markUndoDirty(maskGroup);
                maskGroup.set({ visible: false });
            }
            enforceCanvasLayerOrder(fabricCanvas, genFrame);
            setCandidateState(image, url);
            syncMaskStateFromCanvas(fabricCanvas);
            syncCanvasInteractionMode();
            commitUndoSnapshot(getUndoSnapshotParams(fabricCanvas, genFrame));
            resolve();
        }, { crossOrigin: 'anonymous' });
    });
};

export const restoreHistoryDocument = async ({
    url,
    fabricCanvas,
    genFrame,
    genFrameVisual,
    candidateRef,
    setCandidateState,
    enforceCanvasLayerOrder,
    syncMaskStateFromCanvas,
    syncCanvasInteractionMode,
    syncFrameVisualState,
    setGenDimensions,
    markUndoDirty,
    commitUndoSnapshot,
    getUndoSnapshotParams
}) => {
    if (!fabricCanvas || !genFrame || !genFrameVisual) return;

    const response = await fetch(resolveApiUrl(url), { mode: 'cors' });
    if (!response.ok) {
        throw new Error(`Failed to load history image: ${response.status}`);
    }

    const imageBlob = await response.blob();
    const dataUrl = await blobToDataURL(imageBlob);

    await new Promise((resolve, reject) => {
        fabric.Image.fromURL(dataUrl, (image) => {
            if (!image) {
                reject(new Error('Failed to decode history image.'));
                return;
            }

            fabricCanvas.discardActiveObject();
            fabricCanvas.getObjects()
                .filter((object) => object !== genFrame && object !== genFrameVisual)
                .forEach((object) => fabricCanvas.remove(object));

            genFrame.set({
                width: image.width,
                height: image.height,
                scaleX: 1,
                scaleY: 1
            });
            genFrame.setCoords();
            syncFrameVisualState(genFrame, genFrameVisual);

            image.set({
                left: genFrame.left,
                top: genFrame.top,
                originX: 'left',
                originY: 'top',
                scaleX: 1,
                scaleY: 1,
                objectCaching: false,
                noScaleCache: false,
                selectable: false,
                evented: false,
                hasControls: false,
                lockRotation: true,
                editorRole: CANVAS_OBJECT_ROLES.BASE,
                hoverCursor: 'default'
            });

            image.setCoords();
            fabricCanvas.add(image);
            fabricCanvas.setActiveObject(image);

            if (candidateRef.current) {
                candidateRef.current = null;
            }
            setCandidateState(null, null);
            setGenDimensions({ width: image.width, height: image.height });
            markUndoDirty(genFrame);
            markUndoDirty(genFrameVisual);
            enforceCanvasLayerOrder(fabricCanvas, genFrame);
            syncMaskStateFromCanvas(fabricCanvas);
            syncCanvasInteractionMode();
            commitUndoSnapshot(getUndoSnapshotParams(fabricCanvas, genFrame, genFrameVisual));
            resolve();
        }, { crossOrigin: 'anonymous' });
    });
};

export const clearEditorOverlays = ({
    fabricCanvas,
    genFrame,
    isMaskObject,
    isSketchObject,
    enforceCanvasLayerOrder,
    syncCandidateFromCanvas,
    syncMaskStateFromCanvas,
    syncCanvasInteractionMode,
    commitUndoSnapshot,
    getUndoSnapshotParams
}) => {
    if (!fabricCanvas || !genFrame) return;

    const removableObjects = fabricCanvas.getObjects().filter((object) => (
        isMaskObject(object, genFrame) || isSketchObject(object, genFrame)
    ));
    if (removableObjects.length === 0) return;

    removableObjects.forEach((object) => {
        fabricCanvas.remove(object);
    });

    fabricCanvas.discardActiveObject();
    enforceCanvasLayerOrder(fabricCanvas, genFrame);
    syncCandidateFromCanvas(fabricCanvas);
    syncMaskStateFromCanvas(fabricCanvas);
    syncCanvasInteractionMode();
    commitUndoSnapshot(getUndoSnapshotParams(fabricCanvas, genFrame));
};
