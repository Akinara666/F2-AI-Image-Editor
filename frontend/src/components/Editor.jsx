import React, { useEffect, useRef, useState, useImperativeHandle, forwardRef } from 'react';
import { fabric } from 'fabric';
import {
    applyEraserPathToCanvas,
    bakeCandidateIntoCanvas,
    enforceCanvasLayerOrder,
    exportDocumentSnapshot,
    exportCanvasState,
    isBaseRasterObject,
    isCandidateObject,
    isMaskObject,
    isSketchObject
} from '../utils/canvasLogic';
import { CANVAS_DEFAULTS, CANVAS_OBJECT_ROLES } from '../constants';
import {
    applyFrameViewportStyle,
    FRAME_DASH_PATTERN,
    FRAME_STROKE_WIDTH,
    serializeFrameState,
    serializeFrameVisualState
} from './editor/helpers';
import {
    acceptCandidate,
    addGeneratedImage,
    clearEditorOverlays,
    deleteActiveObject,
    discardCandidate,
    setGenerationFrameSize,
    undoEditorChange
} from './editor/commands';
import {
    applyCanvasInteractionMode,
    setupPathCreationHandling
} from './editor/interactionController';
import { setupEditorKeyboardShortcuts } from './editor/keyboardController';
import { setupCanvasViewportAndTransform } from './editor/transformController';
import { useEditorDocumentState } from './editor/useEditorDocumentState';
import { useEditorUndo } from './editor/useEditorUndo';
import './Editor.css';

const Editor = forwardRef(({ brushMode, brushColor, brushSize }, ref) => {
    const canvasRef = useRef(null);
    const wrapperRef = useRef(null);
    const [fabricCanvas, setFabricCanvas] = useState(null);
    const [isMutatingCanvas, setIsMutatingCanvas] = useState(false);

    const brushModeRef = useRef(brushMode);
    const brushColorRef = useRef(brushColor);
    const brushSizeRef = useRef(brushSize);
    const mutationQueueRef = useRef(Promise.resolve());
    const {
        candidate,
        candidateRef,
        candidateUrl,
        genDimensions,
        genFrame,
        genFrameVisualRef,
        hasMaskOverlay,
        isMaskOverlayVisible,
        maskOverlayVisibleRef,
        getMaskGroupFromCanvas,
        setCandidateState,
        setGenDimensions,
        setGenFrame,
        setMaskOverlayVisibility,
        syncCandidateFromCanvas,
        syncFrameVisualState,
        syncMaskStateFromCanvas
    } = useEditorDocumentState({
        fabricCanvas,
        isCandidateObject
    });
    const {
        createUndoSnapshot,
        commitUndoSnapshot,
        markUndoDirty,
        popUndoSnapshot,
        pushUndoSnapshot,
        restoreUndoSnapshot
    } = useEditorUndo();

    const getUndoSnapshotParams = (
        canvas = fabricCanvas,
        frameObject = genFrame,
        frameVisualObject = genFrameVisualRef.current
    ) => ({
        canvas,
        frameObject,
        frameVisualObject,
        serializeFrameState,
        serializeFrameVisualState
    });

    const getUndoRestoreParams = (
        snapshot,
        canvas = fabricCanvas,
        frameObject = genFrame,
        frameVisualObject = genFrameVisualRef.current
    ) => ({
        snapshot,
        canvas,
        frameObject,
        frameVisualObject,
        genFrameVisualRef,
        syncFrameVisualState,
        applyFrameViewportStyle,
        setGenFrame,
        setGenDimensions,
        enforceCanvasLayerOrder,
        syncCandidateFromCanvas,
        syncMaskStateFromCanvas,
        syncCanvasInteractionMode
    });

    const enqueueCanvasMutation = async (mutation) => {
        const task = mutationQueueRef.current.then(async () => {
            setIsMutatingCanvas(true);
            try {
                return await mutation();
            } finally {
                setIsMutatingCanvas(false);
            }
        });
        mutationQueueRef.current = task.catch((error) => {
            console.error('Canvas mutation failed', error);
        });
        return task;
    };

    useEffect(() => {
        brushModeRef.current = brushMode;
        brushColorRef.current = brushColor;
        brushSizeRef.current = brushSize;
    }, [brushMode, brushColor, brushSize]);

    useEffect(() => {
        if (!canvasRef.current || !wrapperRef.current) return;

        const canvas = new fabric.Canvas(canvasRef.current, {
            width: wrapperRef.current.clientWidth,
            height: wrapperRef.current.clientHeight,
            backgroundColor: null,
            isDrawingMode: false,
            enableRetinaScaling: false,
            preserveObjectStacking: true
        });

        setFabricCanvas(canvas);

        const updateFrameViewportStyle = (zoomLevel) => {
            applyFrameViewportStyle(frameVisual, zoomLevel);
        };

        const frame = new fabric.Rect({
            left: CANVAS_DEFAULTS.GRID_SIZE * 2,
            top: CANVAS_DEFAULTS.GRID_SIZE * 2,
            width: CANVAS_DEFAULTS.DEFAULT_WIDTH,
            height: CANVAS_DEFAULTS.DEFAULT_HEIGHT,
            fill: 'rgba(0, 0, 0, 0)',
            stroke: null,
            strokeWidth: 0,
            hasBorders: false,
            hasControls: true,
            lockRotation: true,
            hoverCursor: 'move',
            perPixelTargetFind: false,
            transparentCorners: false,
            cornerSize: 14,
            originX: 'left',
            originY: 'top',
            editorRole: CANVAS_OBJECT_ROLES.FRAME_HIT_AREA
        });

        const frameVisual = new fabric.Rect({
            left: frame.left,
            top: frame.top,
            width: frame.width,
            height: frame.height,
            fill: null,
            stroke: CANVAS_DEFAULTS.FRAME_COLOR,
            strokeWidth: FRAME_STROKE_WIDTH,
            strokeDashArray: FRAME_DASH_PATTERN,
            selectable: false,
            evented: false,
            hasBorders: false,
            hasControls: false,
            originX: 'left',
            originY: 'top',
            editorRole: CANVAS_OBJECT_ROLES.FRAME
        });

        genFrameVisualRef.current = frameVisual;
        updateFrameViewportStyle(1);
        canvas.add(frame);
        canvas.add(frameVisual);
        syncFrameVisualState(frame, frameVisual);
        setGenFrame(frame);
        pushUndoSnapshot(createUndoSnapshot(getUndoSnapshotParams(canvas, frame, frameVisual)));
        const cleanupViewportAndTransform = setupCanvasViewportAndTransform({
            canvas,
            wrapperElement: wrapperRef.current,
            frame,
            frameVisual,
            brushModeRef,
            gridSize: CANVAS_DEFAULTS.GRID_SIZE,
            updateFrameViewportStyle,
            syncFrameVisualState,
            setGenDimensions,
            markUndoDirty,
            commitUndoSnapshot,
            getUndoSnapshotParams,
            isCandidateObject,
            isBaseRasterObject
        });
        return () => {
            cleanupViewportAndTransform();
            canvas.dispose();
        };
    }, []);

    const syncCanvasInteractionMode = (
        canvas = fabricCanvas,
        frameObject = genFrame,
        currentCandidate = candidateRef.current
    ) => applyCanvasInteractionMode({
        canvas,
        frameObject,
        currentCandidate,
        brushMode: brushModeRef.current,
        brushColor: brushColorRef.current,
        brushSize: brushSizeRef.current,
        isBaseRasterObject,
        isCandidateObject,
        enforceCanvasLayerOrder
    });

    const setTrackedMaskOverlayVisibility = (visible, canvas = fabricCanvas) => {
        const maskGroup = getMaskGroupFromCanvas(canvas);
        if (maskGroup && maskGroup.visible !== visible) {
            markUndoDirty(maskGroup);
        }
        return setMaskOverlayVisibility(visible, canvas);
    };

    useEffect(() => {
        syncCanvasInteractionMode();
    }, [brushMode, brushColor, brushSize, fabricCanvas, genFrame, candidate]);

    useEffect(() => {
        if (!fabricCanvas || !genFrame) return;
        return setupPathCreationHandling({
            canvas: fabricCanvas,
            frameObject: genFrame,
            brushModeRef,
            candidateRef,
            maskOverlayVisibleRef,
            canvasObjectRoles: CANVAS_OBJECT_ROLES,
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
        });
    }, [fabricCanvas, genFrame]);

    const discardCandidateHelper = () => discardCandidate({
        fabricCanvas,
        candidateRef,
        setCandidateState,
        setMaskOverlayVisibility: setTrackedMaskOverlayVisibility,
        syncCanvasInteractionMode,
        commitUndoSnapshot,
        getUndoSnapshotParams,
        genFrame
    });

    const performAccept = async () => acceptCandidate({
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
    });

    const performUndo = async () => undoEditorChange({
        fabricCanvas,
        genFrame,
        enqueueCanvasMutation,
        popUndoSnapshot,
        restoreUndoSnapshot,
        getUndoRestoreParams,
        genFrameVisualRef
    });

    const performDeleteActiveObject = () => deleteActiveObject({
        fabricCanvas,
        genFrame,
        syncCandidateFromCanvas,
        syncCanvasInteractionMode,
        commitUndoSnapshot,
        getUndoSnapshotParams
    });

    useImperativeHandle(ref, () => ({
        setGenFrameSize: (width, height) => setGenerationFrameSize({
            width,
            height,
            genFrame,
            genFrameVisual: genFrameVisualRef.current,
            fabricCanvas,
            syncFrameVisualState,
            setGenDimensions,
            enforceCanvasLayerOrder,
            syncCanvasInteractionMode,
            markUndoDirty,
            commitUndoSnapshot,
            getUndoSnapshotParams
        }),

        addGeneratedImage: async (url) => addGeneratedImage({
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
        }),

        acceptCandidate: () => {
            void performAccept();
        },

        discardCandidate: () => {
            discardCandidateHelper();
        },

        exportForGeneration: async () => exportCanvasState(fabricCanvas, genFrame),

        exportHistorySnapshot: async () => exportDocumentSnapshot(fabricCanvas, genFrame),

        undo: performUndo,

        clearAll: () => clearEditorOverlays({
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
        })
    }));

    const performUndoRef = useRef(performUndo);
    const performDeleteActiveObjectRef = useRef(performDeleteActiveObject);
    const syncCanvasInteractionModeRef = useRef(syncCanvasInteractionMode);
    useEffect(() => {
        performUndoRef.current = performUndo;
        performDeleteActiveObjectRef.current = performDeleteActiveObject;
        syncCanvasInteractionModeRef.current = syncCanvasInteractionMode;
    });

    const toggleMaskOverlayPreview = () => {
        if (!fabricCanvas || !hasMaskOverlay) return;
        setTrackedMaskOverlayVisibility(!isMaskOverlayVisible, fabricCanvas);
    };

    useEffect(() => {
        if (!fabricCanvas || !genFrame) return;
        return setupEditorKeyboardShortcuts({
            fabricCanvas,
            brushModeRef,
            performUndoRef,
            performDeleteActiveObjectRef,
            syncCanvasInteractionModeRef
        });
    }, [fabricCanvas, genFrame]);

    return (
        <div ref={wrapperRef} className="editor-canvas-wrapper">
            <canvas ref={canvasRef} />

            <div className="editor-resolution-badge">
                {genDimensions.width} x {genDimensions.height}
            </div>

            {candidateUrl && (
                <div className="editor-staging-bar">
                    <button
                        className="editor-staging-btn editor-staging-btn--accept"
                        onClick={() => void performAccept()}
                        disabled={isMutatingCanvas}
                    >
                        ✓ ACCEPT
                    </button>
                    <button
                        className="editor-staging-btn editor-staging-btn--discard"
                        onClick={discardCandidateHelper}
                        disabled={isMutatingCanvas}
                    >
                        ✕ DISCARD
                    </button>
                    {hasMaskOverlay && (
                        <button
                            className={`editor-staging-btn editor-staging-btn--mask ${isMaskOverlayVisible ? 'editor-staging-btn--mask-active' : ''}`}
                            onClick={toggleMaskOverlayPreview}
                            disabled={isMutatingCanvas}
                        >
                            {isMaskOverlayVisible ? 'Hide Mask' : 'Show Mask'}
                        </button>
                    )}
                </div>
            )}
        </div>
    );
});

export default Editor;
