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
    restoreHistoryDocument,
    setGenerationFrameSize,
    undoEditorChange
} from './editor/commands';
import {
    applyCanvasInteractionMode,
    setupCloneStampHandling,
    setupPathCreationHandling,
    setupSpotHealInstantHandling
} from './editor/interactionController';
import { setupEditorKeyboardShortcuts } from './editor/keyboardController';
import { setupCanvasViewportAndTransform } from './editor/transformController';
import { useEditorDocumentState } from './editor/useEditorDocumentState';
import { useEditorUndo } from './editor/useEditorUndo';
import './Editor.css';

const Editor = forwardRef(({ brushMode, setBrushMode, brushColor, brushSize, generationPreview, onSpotHealPoint }, ref) => {
    const canvasRef = useRef(null);
    const wrapperRef = useRef(null);
    const [fabricCanvas, setFabricCanvas] = useState(null);
    const [isMutatingCanvas, setIsMutatingCanvas] = useState(false);
    const [activeImageResolution, setActiveImageResolution] = useState(null);
    const [previewFrameBounds, setPreviewFrameBounds] = useState(null);
    const previewFrameBoundsRef = useRef(null);

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

    useEffect(() => {
        if (!fabricCanvas || !genFrame || !wrapperRef.current) {
            previewFrameBoundsRef.current = null;
            setPreviewFrameBounds(null);
            return undefined;
        }

        const syncPreviewFrameBounds = () => {
            const viewportTransform = fabricCanvas.viewportTransform || fabric.iMatrix.concat();
            const zoomX = viewportTransform[0] ?? fabricCanvas.getZoom();
            const zoomY = viewportTransform[3] ?? fabricCanvas.getZoom();
            const frameObject = genFrameVisualRef.current || genFrame;
            const overlayInset = FRAME_STROKE_WIDTH + 1;
            const rawLeft = (frameObject.left ?? 0) * zoomX + (viewportTransform[4] ?? 0);
            const rawTop = (frameObject.top ?? 0) * zoomY + (viewportTransform[5] ?? 0);
            const rawWidth = Math.max(1, (frameObject.width ?? 0) * (frameObject.scaleX ?? 1) * zoomX);
            const rawHeight = Math.max(1, (frameObject.height ?? 0) * (frameObject.scaleY ?? 1) * zoomY);
            const innerLeft = Math.ceil(rawLeft + overlayInset);
            const innerTop = Math.ceil(rawTop + overlayInset);
            const innerRight = Math.floor(rawLeft + rawWidth - overlayInset);
            const innerBottom = Math.floor(rawTop + rawHeight - overlayInset);
            const wrapperWidth = wrapperRef.current?.clientWidth ?? fabricCanvas.getWidth();
            const wrapperHeight = wrapperRef.current?.clientHeight ?? fabricCanvas.getHeight();
            const nextBounds = {
                left: innerLeft,
                top: innerTop,
                width: Math.max(1, innerRight - innerLeft),
                height: Math.max(1, innerBottom - innerTop),
                visible: innerLeft < wrapperWidth
                    && innerTop < wrapperHeight
                    && innerRight > 0
                    && innerBottom > 0
            };

            const prevBounds = previewFrameBoundsRef.current;
            const unchanged = prevBounds
                && prevBounds.left === nextBounds.left
                && prevBounds.top === nextBounds.top
                && prevBounds.width === nextBounds.width
                && prevBounds.height === nextBounds.height
                && prevBounds.visible === nextBounds.visible;

            if (!unchanged) {
                previewFrameBoundsRef.current = nextBounds;
                setPreviewFrameBounds(nextBounds);
            }
        };

        fabricCanvas.on('after:render', syncPreviewFrameBounds);
        window.addEventListener('resize', syncPreviewFrameBounds);
        syncPreviewFrameBounds();

        return () => {
            fabricCanvas.off('after:render', syncPreviewFrameBounds);
            window.removeEventListener('resize', syncPreviewFrameBounds);
        };
    }, [fabricCanvas, genFrame]);

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

    const syncActiveImageResolution = (target = fabricCanvas?.getActiveObject()) => {
        if (!target) {
            setActiveImageResolution(null);
            return;
        }

        const isImageObject = isCandidateObject(target, genFrame) || isBaseRasterObject(target, genFrame);
        if (!isImageObject) {
            setActiveImageResolution(null);
            return;
        }

        const width = Math.max(1, Math.round((target.width ?? 0) * (target.scaleX ?? 1)));
        const height = Math.max(1, Math.round((target.height ?? 0) * (target.scaleY ?? 1)));
        setActiveImageResolution({ width, height });
    };

    useEffect(() => {
        syncCanvasInteractionMode();
    }, [brushMode, brushColor, brushSize, fabricCanvas, genFrame, candidate]);

    useEffect(() => {
        if (!fabricCanvas || !genFrame) return undefined;

        const handleSelectionChange = (event) => {
            syncActiveImageResolution(event.selected?.[0] || fabricCanvas.getActiveObject());
        };
        const handleSelectionClear = () => {
            setActiveImageResolution(null);
        };
        const handleObjectScaling = (event) => {
            syncActiveImageResolution(event.target);
        };
        const handleObjectModified = (event) => {
            syncActiveImageResolution(event.target);
        };

        fabricCanvas.on('selection:created', handleSelectionChange);
        fabricCanvas.on('selection:updated', handleSelectionChange);
        fabricCanvas.on('selection:cleared', handleSelectionClear);
        fabricCanvas.on('object:scaling', handleObjectScaling);
        fabricCanvas.on('object:modified', handleObjectModified);
        syncActiveImageResolution();

        return () => {
            fabricCanvas.off('selection:created', handleSelectionChange);
            fabricCanvas.off('selection:updated', handleSelectionChange);
            fabricCanvas.off('selection:cleared', handleSelectionClear);
            fabricCanvas.off('object:scaling', handleObjectScaling);
            fabricCanvas.off('object:modified', handleObjectModified);
        };
    }, [fabricCanvas, genFrame, candidate]);

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

    const canSpotHeal = () => {
        if (!fabricCanvas || !genFrame) {
            return false;
        }
        return fabricCanvas.getObjects().some((object) => (
            isBaseRasterObject(object, genFrame) || isCandidateObject(object, genFrame)
        ));
    };

    const exportForSpotHeal = async ({ x, y, radius }) => {
        if (!fabricCanvas || !genFrame) {
            throw new Error('Canvas is not ready for spot heal.');
        }

        const frameWidth = Math.max(1, Math.round((genFrame.width ?? 0) * (genFrame.scaleX ?? 1)));
        const frameHeight = Math.max(1, Math.round((genFrame.height ?? 0) * (genFrame.scaleY ?? 1)));
        const frameLeft = genFrame.left ?? 0;
        const frameTop = genFrame.top ?? 0;
        const safeRadius = Math.max(4, Math.min(192, Number(radius || (brushSizeRef.current || 8) / 2)));
        const safeX = Math.min(frameLeft + frameWidth - 1, Math.max(frameLeft, Number(x ?? frameLeft)));
        const safeY = Math.min(frameTop + frameHeight - 1, Math.max(frameTop, Number(y ?? frameTop)));

        let maskGroup = getMaskGroupFromCanvas(fabricCanvas);
        let createdMaskGroup = false;

        if (!maskGroup) {
            maskGroup = new fabric.Group([], {
                id: 'maskGroup',
                editorRole: CANVAS_OBJECT_ROLES.MASK,
                selectable: false,
                evented: false,
                opacity: 0.5,
                objectCaching: true
            });
            fabricCanvas.add(maskGroup);
            createdMaskGroup = true;
        }

        const tempSpotMask = new fabric.Circle({
            left: safeX - safeRadius,
            top: safeY - safeRadius,
            radius: safeRadius,
            originX: 'left',
            originY: 'top',
            fill: 'rgba(255, 0, 0, 1.0)',
            stroke: 'rgba(255, 0, 0, 1.0)',
            strokeWidth: 0,
            selectable: false,
            evented: false,
            editorRole: CANVAS_OBJECT_ROLES.MASK,
            isMask: true,
            isSpotHeal: true
        });

        maskGroup.addWithUpdate(tempSpotMask);
        enforceCanvasLayerOrder(fabricCanvas, genFrame);
        fabricCanvas.requestRenderAll();

        try {
            return await exportCanvasState(fabricCanvas, genFrame);
        } finally {
            if (typeof maskGroup.removeWithUpdate === 'function') {
                maskGroup.removeWithUpdate(tempSpotMask);
            } else {
                maskGroup.remove(tempSpotMask);
            }

            if (createdMaskGroup && maskGroup.getObjects().length === 0) {
                fabricCanvas.remove(maskGroup);
            }

            syncMaskStateFromCanvas(fabricCanvas);
            enforceCanvasLayerOrder(fabricCanvas, genFrame);
            fabricCanvas.requestRenderAll();
        }
    };

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

        acceptCandidateAsync: async () => performAccept(),

        discardCandidate: () => {
            discardCandidateHelper();
        },

        exportForGeneration: async () => exportCanvasState(fabricCanvas, genFrame),

        exportForSpotHeal,

        canSpotHeal,

        exportHistorySnapshot: async () => exportDocumentSnapshot(fabricCanvas, genFrame),

        restoreHistoryDocument: async (url) => restoreHistoryDocument({
            url,
            fabricCanvas,
            genFrame,
            genFrameVisual: genFrameVisualRef.current,
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
        }),

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
    const setBrushModeRef = useRef(setBrushMode);
    const performDeleteActiveObjectRef = useRef(performDeleteActiveObject);
    const syncCanvasInteractionModeRef = useRef(syncCanvasInteractionMode);
    useEffect(() => {
        performUndoRef.current = performUndo;
        setBrushModeRef.current = setBrushMode;
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
            setBrushModeRef,
            performUndoRef,
            performDeleteActiveObjectRef,
            syncCanvasInteractionModeRef
        });
    }, [fabricCanvas, genFrame]);

    useEffect(() => {
        if (!fabricCanvas || !genFrame) return undefined;
        return setupCloneStampHandling({
            canvas: fabricCanvas,
            frameObject: genFrame,
            brushModeRef,
            brushSizeRef,
            candidateRef,
            isBaseRasterObject,
            isCandidateObject,
            markUndoDirty,
            commitUndoSnapshot,
            getUndoSnapshotParams
        });
    }, [fabricCanvas, genFrame]);

    useEffect(() => {
        if (!fabricCanvas) return undefined;
        return setupSpotHealInstantHandling({
            canvas: fabricCanvas,
            brushModeRef,
            brushSizeRef,
            onSpotHealPoint
        });
    }, [fabricCanvas, onSpotHealPoint]);

    return (
        <div ref={wrapperRef} className="editor-canvas-wrapper">
            <canvas ref={canvasRef} />

            <div className="editor-resolution-badge">
                {genDimensions.width} x {genDimensions.height}
            </div>

            {activeImageResolution && (
                <div className="editor-object-resolution-badge">
                    {activeImageResolution.width} x {activeImageResolution.height}
                </div>
            )}

            {generationPreview?.image_data_url && previewFrameBounds?.visible && (
                <div
                    className="editor-live-preview"
                    style={{
                        left: `${previewFrameBounds.left}px`,
                        top: `${previewFrameBounds.top}px`,
                        width: `${previewFrameBounds.width}px`,
                        height: `${previewFrameBounds.height}px`
                    }}
                >
                    <img
                        className="editor-live-preview__image"
                        src={generationPreview.image_data_url}
                        alt={`Предпросмотр генерации, шаг ${generationPreview.step}`}
                    />
                    <div className="editor-live-preview__hud">
                        <div className="editor-live-preview__header">
                            <span className="editor-live-preview__title">Предпросмотр</span>
                            <span className="editor-live-preview__step">
                                Шаг {generationPreview.step} / {generationPreview.total_steps}
                            </span>
                        </div>
                        <div className="editor-live-preview__progress">
                            <div
                                className="editor-live-preview__progress-bar"
                                style={{ width: `${Math.max(0, Math.min(100, (generationPreview.progress || 0) * 100))}%` }}
                            />
                        </div>
                    </div>
                </div>
            )}

            {candidateUrl && (
                <div className="editor-staging-bar">
                    <button
                        className="editor-staging-btn editor-staging-btn--accept"
                        onClick={() => void performAccept()}
                        disabled={isMutatingCanvas}
                    >
                        ✓ ПРИНЯТЬ
                    </button>
                    <button
                        className="editor-staging-btn editor-staging-btn--discard"
                        onClick={discardCandidateHelper}
                        disabled={isMutatingCanvas}
                    >
                        ✕ ОТМЕНИТЬ
                    </button>
                    {hasMaskOverlay && (
                        <button
                            className={`editor-staging-btn editor-staging-btn--mask ${isMaskOverlayVisible ? 'editor-staging-btn--mask-active' : ''}`}
                            onClick={toggleMaskOverlayPreview}
                            disabled={isMutatingCanvas}
                        >
                            {isMaskOverlayVisible ? 'Скрыть маску' : 'Показать маску'}
                        </button>
                    )}
                </div>
            )}
        </div>
    );
});

export default Editor;
