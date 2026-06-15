import React, { useEffect, useRef, useState, useImperativeHandle, forwardRef } from 'react';
import { fabric } from 'fabric';
import {
    applyEraserPathToCanvas,
    bakeCandidateIntoCanvas,
    enforceCanvasLayerOrder,
    exportCanvasAsFile,
    exportDocumentSnapshot,
    exportCanvasState,
    importImageFromUrl,
    importImageToCanvas,
    isBaseRasterObject,
    isCandidateObject,
    isMaskObject,
    isSketchObject,
    buildMaskBoundaryCanvas,
    UI_OVERLAY_ROLES
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
    resizeDocumentCanvas,
    resizeDocumentImage,
    restoreHistoryDocument,
    setGenerationFrameRect,
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
import {
    combineSelections,
    featherSelection,
    invertSelection,
    traceSelectionOutline
} from './editor/selectionEngine';
import { setupSelectionToolHandling } from './editor/selectionController';
import { createAdjustmentSession } from './editor/adjustmentSession';
import { setupDrawingToolHandling } from './editor/drawingToolsController';
import { setupCropToolHandling } from './editor/cropController';
import { TOOL_MODES } from './editor/toolModes';
import { magicWandMask, sampleMaskForLayer, sampleSelectionAt } from './editor/selectionEngine';
import { cloneCanvasElement, ensureWritableCanvasElement, worldPointToLocal } from './editor/rasterUtils';
import { ADJUSTMENT_TYPES } from '../utils/imageFilters';
import AdjustmentsDialog from './AdjustmentsDialog';
import { useEditorDocumentState } from './editor/useEditorDocumentState';
import { useEditorUndo } from './editor/useEditorUndo';
import './Editor.css';

const QUICK_SELECT_MODE = 'quick_select';
const LAYER_KIND_LABELS = {
    [CANVAS_OBJECT_ROLES.BASE]: 'Raster',
    [CANVAS_OBJECT_ROLES.CANDIDATE]: 'Candidate',
    [CANVAS_OBJECT_ROLES.SKETCH]: 'Sketch',
    [CANVAS_OBJECT_ROLES.MASK]: 'Mask'
};
const BLEND_MODE_TO_COMPOSITE = {
    normal: 'source-over',
    multiply: 'multiply',
    screen: 'screen',
    overlay: 'overlay'
};
const COMPOSITE_TO_BLEND_MODE = Object.fromEntries(
    Object.entries(BLEND_MODE_TO_COMPOSITE).map(([blendMode, composite]) => [composite, blendMode])
);

const hasVisiblePixels = (canvasElement) => {
    const context = canvasElement.getContext('2d', { willReadFrequently: true });
    if (!context) {
        return false;
    }

    const { data } = context.getImageData(0, 0, canvasElement.width, canvasElement.height);
    for (let index = 3; index < data.length; index += 4) {
        if (data[index] !== 0) {
            return true;
        }
    }
    return false;
};

const resolveLayerKind = (object) => {
    if (!object) return CANVAS_OBJECT_ROLES.BASE;
    if (object.id === 'maskGroup' || object.isMask || object.editorRole === CANVAS_OBJECT_ROLES.MASK) {
        return CANVAS_OBJECT_ROLES.MASK;
    }
    if (object.isCandidate || object.editorRole === CANVAS_OBJECT_ROLES.CANDIDATE) {
        return CANVAS_OBJECT_ROLES.CANDIDATE;
    }
    if (object.editorRole === CANVAS_OBJECT_ROLES.SKETCH) {
        return CANVAS_OBJECT_ROLES.SKETCH;
    }
    return CANVAS_OBJECT_ROLES.BASE;
};

const clampLayerPercent = (value, fallback = 100) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return fallback;
    }
    return Math.max(0, Math.min(100, Math.round(numeric)));
};

const Editor = forwardRef(({ brushMode, setBrushMode, brushColor, setBrushColor, brushSize, generationPreview, onSpotHealPoint, onLayersChange, onToolNotify }, ref) => {
    const canvasRef = useRef(null);
    const wrapperRef = useRef(null);
    const [fabricCanvas, setFabricCanvas] = useState(null);
    const [isMutatingCanvas, setIsMutatingCanvas] = useState(false);
    const [isDragOver, setIsDragOver] = useState(false);
    const [activeImageResolution, setActiveImageResolution] = useState(null);
    const [isCanvasEmpty, setIsCanvasEmpty] = useState(true);
    const [previewFrameBounds, setPreviewFrameBounds] = useState(null);
    const previewFrameBoundsRef = useRef(null);
    const quickSelectionOverlayRef = useRef(null);
    const quickSelectionRef = useRef(null);
    const quickSelectionDraftPointsRef = useRef([]);
    const quickClipboardRef = useRef(null);
    const layerCounterRef = useRef(1);
    const selectionRef = useRef(null);
    const selectionOverlayRef = useRef(null);
    const selectionAntsTimerRef = useRef(null);
    const magicWandToleranceRef = useRef(32);
    const adjustmentSessionRef = useRef(null);
    const [activeAdjustment, setActiveAdjustment] = useState(null);
    const textOptionsRef = useRef({ fontSize: 32 });
    const shapeOptionsRef = useRef({ kind: 'rect', outlineOnly: false, strokeWidth: 2 });
    const fillToleranceRef = useRef(32);
    const gradientOptionsRef = useRef({ toTransparent: true, endColor: '#000000' });
    const setBrushColorRef = useRef(setBrushColor);
    const onToolNotifyRef = useRef(onToolNotify);
    const cropRectRef = useRef(null);

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

    const isLayerPanelObject = (object) => (
        Boolean(object)
        && object !== genFrame
        && object.editorRole !== CANVAS_OBJECT_ROLES.FRAME
        && object.editorRole !== CANVAS_OBJECT_ROLES.FRAME_HIT_AREA
        && !UI_OVERLAY_ROLES.includes(object.editorRole)
    );

    const cloneCanvasObject = (source) => (
        new Promise((resolve, reject) => {
            source.clone((cloned) => {
                if (!cloned) {
                    reject(new Error('Failed to clone layer object.'));
                    return;
                }
                resolve(cloned);
            });
        })
    );

    const ensureLayerId = (object) => {
        if (!object) return null;
        if (!object.editorLayerId) {
            object.editorLayerId = `layer-${layerCounterRef.current++}`;
        }
        return object.editorLayerId;
    };

    const getLayerStyle = (object) => {
        const baseOpacity = clampLayerPercent(
            object?.editorLayerOpacity,
            clampLayerPercent(((object?.opacity ?? 1) * 100), 100)
        );
        const fillOpacity = clampLayerPercent(object?.editorLayerFillOpacity, 100);
        const blendMode = object?.editorLayerBlendMode
            || COMPOSITE_TO_BLEND_MODE[object?.globalCompositeOperation]
            || 'normal';
        const locked = object?.editorLayerLocked === true;
        return {
            opacity: baseOpacity,
            fill: fillOpacity,
            blendMode,
            locked
        };
    };

    const applyLayerStyle = (object, patch = {}) => {
        if (!object) {
            return null;
        }

        const current = getLayerStyle(object);
        const nextOpacity = clampLayerPercent(patch.opacity, current.opacity);
        const nextFill = clampLayerPercent(patch.fill, current.fill);
        const nextBlendMode = BLEND_MODE_TO_COMPOSITE[patch.blendMode] ? patch.blendMode : current.blendMode;
        const nextLocked = typeof patch.locked === 'boolean' ? patch.locked : current.locked;
        const composite = BLEND_MODE_TO_COMPOSITE[nextBlendMode] || BLEND_MODE_TO_COMPOSITE.normal;
        const effectiveOpacity = Math.max(0, Math.min(1, (nextOpacity / 100) * (nextFill / 100)));

        object.set({
            opacity: effectiveOpacity,
            globalCompositeOperation: composite,
            lockMovementX: nextLocked,
            lockMovementY: nextLocked,
            lockRotation: nextLocked,
            lockScalingX: nextLocked,
            lockScalingY: nextLocked
        });
        object.editorLayerOpacity = nextOpacity;
        object.editorLayerFillOpacity = nextFill;
        object.editorLayerBlendMode = nextBlendMode;
        object.editorLayerLocked = nextLocked;
        object.setCoords();

        return {
            opacity: nextOpacity,
            fill: nextFill,
            blendMode: nextBlendMode,
            locked: nextLocked
        };
    };

    const getLayerDisplayName = (object, index) => {
        const customName = typeof object?.editorLayerName === 'string' ? object.editorLayerName.trim() : '';
        if (customName) return customName;
        const kind = resolveLayerKind(object);
        const baseName = kind === CANVAS_OBJECT_ROLES.CANDIDATE
            ? 'Candidate'
            : (kind === CANVAS_OBJECT_ROLES.MASK ? 'Mask' : (kind === CANVAS_OBJECT_ROLES.SKETCH ? 'Sketch' : 'Layer'));
        return `${baseName} ${index}`;
    };

    const buildLayersSnapshot = React.useCallback(() => {
        if (!fabricCanvas || !genFrame) {
            return [];
        }

        const layerObjects = fabricCanvas
            .getObjects()
            .filter((object) => isLayerPanelObject(object));
        const activeObject = fabricCanvas.getActiveObject();
        const visualOrderTopFirst = [...layerObjects].reverse();

        return visualOrderTopFirst.map((object, index) => {
            const kind = resolveLayerKind(object);
            const style = getLayerStyle(object);
            const vectorLabel = object.type === 'i-text'
                ? 'Text'
                : (['rect', 'ellipse', 'line'].includes(object.type) ? 'Shape' : null);
            return {
                id: ensureLayerId(object),
                name: getLayerDisplayName(object, visualOrderTopFirst.length - index),
                kind,
                kindLabel: vectorLabel || LAYER_KIND_LABELS[kind] || 'Layer',
                visible: object.visible !== false,
                isActive: object === activeObject,
                opacity: style.opacity,
                fill: style.fill,
                blendMode: style.blendMode,
                locked: style.locked
            };
        });
    }, [fabricCanvas, genFrame]);

    const emitLayersSnapshot = React.useCallback(() => {
        const layersSnapshot = buildLayersSnapshot();
        setIsCanvasEmpty(layersSnapshot.length === 0);
        if (typeof onLayersChange !== 'function') {
            return;
        }
        onLayersChange(layersSnapshot);
    }, [onLayersChange, buildLayersSnapshot]);

    const findLayerObjectById = (layerId) => {
        if (!fabricCanvas || !layerId) {
            return null;
        }

        return fabricCanvas
            .getObjects()
            .find((object) => isLayerPanelObject(object) && ensureLayerId(object) === layerId) || null;
    };

    const selectLayer = (layerId) => {
        if (!fabricCanvas) {
            return false;
        }
        const target = findLayerObjectById(layerId);
        if (!target || target.visible === false || target.editorLayerLocked === true) {
            return false;
        }

        fabricCanvas.setActiveObject(target);
        fabricCanvas.requestRenderAll();
        emitLayersSnapshot();
        return true;
    };

    const toggleLayerVisibility = (layerId) => {
        if (!fabricCanvas) {
            return false;
        }
        const target = findLayerObjectById(layerId);
        if (!target) {
            return false;
        }

        markUndoDirty(target);
        target.set({ visible: target.visible === false });
        if (target.visible === false && fabricCanvas.getActiveObject() === target) {
            fabricCanvas.discardActiveObject();
        }
        syncCanvasInteractionMode();
        commitUndoSnapshot(getUndoSnapshotParams(fabricCanvas, genFrame));
        fabricCanvas.requestRenderAll();
        emitLayersSnapshot();
        return true;
    };

    const addLayer = async () => {
        if (!fabricCanvas || !genFrame) {
            return false;
        }

        const source = fabricCanvas.getActiveObject()
            || [...fabricCanvas.getObjects()].reverse().find((object) => isLayerPanelObject(object) && object.visible !== false);
        if (!source) {
            return false;
        }

        const cloned = await cloneCanvasObject(source);
        const left = Number(source.left ?? 0) + 20;
        const top = Number(source.top ?? 0) + 20;
        cloned.set({
            left,
            top,
            visible: true,
            selectable: true,
            evented: true
        });
        cloned.editorLayerName = `${getLayerDisplayName(source, 1)} copy`;
        ensureLayerId(cloned);
        applyLayerStyle(cloned, {
            ...getLayerStyle(source),
            locked: false
        });
        cloned.setCoords();

        fabricCanvas.add(cloned);
        fabricCanvas.setActiveObject(cloned);
        syncCanvasInteractionMode();
        commitUndoSnapshot(getUndoSnapshotParams(fabricCanvas, genFrame));
        fabricCanvas.requestRenderAll();
        emitLayersSnapshot();
        return true;
    };

    const toggleLayerLock = (layerId) => {
        if (!fabricCanvas) {
            return false;
        }
        const target = findLayerObjectById(layerId);
        if (!target) {
            return false;
        }

        markUndoDirty(target);
        applyLayerStyle(target, { locked: target.editorLayerLocked !== true });
        if (target.editorLayerLocked === true && fabricCanvas.getActiveObject() === target) {
            fabricCanvas.discardActiveObject();
        }
        syncCanvasInteractionMode();
        commitUndoSnapshot(getUndoSnapshotParams(fabricCanvas, genFrame));
        fabricCanvas.requestRenderAll();
        emitLayersSnapshot();
        return true;
    };

    const updateLayerStyle = (layerId, patch) => {
        if (!fabricCanvas) {
            return false;
        }
        const target = findLayerObjectById(layerId);
        if (!target) {
            return false;
        }

        markUndoDirty(target);
        applyLayerStyle(target, patch);
        syncCanvasInteractionMode();
        commitUndoSnapshot(getUndoSnapshotParams(fabricCanvas, genFrame));
        fabricCanvas.requestRenderAll();
        emitLayersSnapshot();
        return true;
    };

    useEffect(() => {
        brushModeRef.current = brushMode;
        brushColorRef.current = brushColor;
        brushSizeRef.current = brushSize;
    }, [brushMode, brushColor, brushSize]);

    useEffect(() => {
        setBrushColorRef.current = setBrushColor;
        onToolNotifyRef.current = onToolNotify;
    });

    useEffect(() => {
        if (!fabricCanvas) {
            return undefined;
        }

        const handleLayerRelevantEvent = () => {
            emitLayersSnapshot();
        };

        const events = [
            'object:added',
            'object:removed',
            'object:modified',
            'selection:created',
            'selection:updated',
            'selection:cleared'
        ];

        events.forEach((eventName) => {
            fabricCanvas.on(eventName, handleLayerRelevantEvent);
        });
        handleLayerRelevantEvent();

        return () => {
            events.forEach((eventName) => {
                fabricCanvas.off(eventName, handleLayerRelevantEvent);
            });
        };
    }, [fabricCanvas, emitLayersSnapshot]);

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

    // Живое превью зоны генерации: поверх маски кладём временный оверлей с
    // полупрозрачной заливкой расширенной области и ЧЁТКОЙ кромкой по границе
    // (padding+blur наружу). Роль 'mask-boundary-overlay' входит в
    // UI_OVERLAY_ROLES, поэтому оверлей не попадает ни в undo, ни в экспорт.
    const maskFeatherPreviewRef = useRef({ blur: 0, padding: 0, enabled: false });

    const applyMaskFeatherPreview = (canvas = fabricCanvas) => {
        if (!canvas) {
            return;
        }
        const prev = canvas.getObjects().find((object) => object.editorRole === 'mask-boundary-overlay');
        if (prev) {
            canvas.remove(prev);
        }

        const maskGroup = getMaskGroupFromCanvas(canvas);
        const { blur, padding, enabled } = maskFeatherPreviewRef.current;
        if (!enabled || !maskGroup || maskGroup.getObjects().length === 0) {
            canvas.requestRenderAll();
            return;
        }

        // Силуэт снимаем при полной непрозрачности (группа рисуется с opacity
        // 0.5 — после dilate альфа просела бы ниже порога и контур исчез) и без
        // тени (на случай легаси-shadow на группе).
        const savedShadow = maskGroup.shadow;
        const savedOpacity = maskGroup.opacity;
        maskGroup.shadow = null;
        maskGroup.opacity = 1;
        const silhouette = maskGroup.toCanvasElement({ enableRetinaScaling: false });
        maskGroup.shadow = savedShadow;
        maskGroup.opacity = savedOpacity;

        const bbox = maskGroup.getBoundingRect(true, true);
        // padding и blur передаём раздельно: padding двигает жёсткую границу,
        // blur рисует градиентную полосу растушёвки — их видно по отдельности.
        const { canvas: haloCanvas, margin } = buildMaskBoundaryCanvas(
            silhouette,
            Math.max(0, padding),
            Math.max(0, blur)
        );

        const overlay = new fabric.Image(haloCanvas, {
            left: bbox.left - margin,
            top: bbox.top - margin,
            selectable: false,
            evented: false,
            objectCaching: false,
            excludeFromExport: true,
            hoverCursor: 'default',
            editorRole: 'mask-boundary-overlay'
        });
        canvas.add(overlay);
        overlay.bringToFront();
        canvas.requestRenderAll();
    };

    const setMaskFeatherPreview = ({ blur, padding, enabled }) => {
        maskFeatherPreviewRef.current = {
            blur: Number(blur) || 0,
            padding: Number(padding) || 0,
            enabled: Boolean(enabled)
        };
        applyMaskFeatherPreview();
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
            applyEraserPathToCanvas,
            onMaskChanged: applyMaskFeatherPreview
        });
    }, [fabricCanvas, genFrame]);

    // Превью-кромка живёт отдельным оверлеем (роль mask-boundary-overlay), и её
    // не удаляют команды, чистящие маску по isMaskObject (очистка, принятие
    // результата, удаление). Снимаем оверлей всегда, когда исчезает maskGroup.
    useEffect(() => {
        if (!fabricCanvas) return undefined;
        const handleObjectRemoved = (event) => {
            if (event?.target?.id !== 'maskGroup') return;
            const overlay = fabricCanvas
                .getObjects()
                .find((object) => object.editorRole === 'mask-boundary-overlay');
            if (overlay) {
                fabricCanvas.remove(overlay);
                fabricCanvas.requestRenderAll();
            }
        };
        fabricCanvas.on('object:removed', handleObjectRemoved);
        return () => fabricCanvas.off('object:removed', handleObjectRemoved);
    }, [fabricCanvas]);

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

    const performUndo = async () => {
        // Открытая коррекция держит подменённый элемент слоя — откатываем её
        // перед восстановлением снапшота.
        if (adjustmentSessionRef.current) {
            adjustmentSessionRef.current.cancel();
            adjustmentSessionRef.current = null;
            setActiveAdjustment(null);
        }
        return undoEditorChange({
            fabricCanvas,
            genFrame,
            enqueueCanvasMutation,
            popUndoSnapshot,
            restoreUndoSnapshot,
            getUndoRestoreParams,
            genFrameVisualRef
        });
    };

    const performDeleteActiveObject = () => deleteActiveObject({
        fabricCanvas,
        genFrame,
        syncCandidateFromCanvas,
        syncCanvasInteractionMode,
        commitUndoSnapshot,
        getUndoSnapshotParams
    });

    const getFrameBounds = () => {
        if (!genFrame) {
            return null;
        }
        const left = genFrame.left ?? 0;
        const top = genFrame.top ?? 0;
        const width = Math.max(1, Math.round((genFrame.width ?? 0) * (genFrame.scaleX ?? 1)));
        const height = Math.max(1, Math.round((genFrame.height ?? 0) * (genFrame.scaleY ?? 1)));
        return {
            left,
            top,
            right: left + width,
            bottom: top + height
        };
    };

    const clampPointToFrame = (point) => {
        const frameBounds = getFrameBounds();
        if (!frameBounds || !point) {
            return point;
        }
        return {
            x: Math.max(frameBounds.left, Math.min(frameBounds.right, point.x)),
            y: Math.max(frameBounds.top, Math.min(frameBounds.bottom, point.y))
        };
    };

    const canvasToBlob = (canvasElement, type = 'image/png') => (
        new Promise((resolve, reject) => {
            canvasElement.toBlob((blob) => {
                if (!blob) {
                    reject(new Error('Failed to build selection blob.'));
                    return;
                }
                resolve(blob);
            }, type);
        })
    );

    const calculateQuickSelectionBounds = (points) => {
        if (!points || points.length < 3) {
            return null;
        }
        const left = Math.min(...points.map((point) => point.x));
        const top = Math.min(...points.map((point) => point.y));
        const right = Math.max(...points.map((point) => point.x));
        const bottom = Math.max(...points.map((point) => point.y));
        return {
            left: Math.round(left),
            top: Math.round(top),
            width: Math.max(1, Math.round(right - left)),
            height: Math.max(1, Math.round(bottom - top))
        };
    };

    const ensureQuickSelectionOverlay = () => {
        if (!fabricCanvas || !genFrame) {
            return null;
        }
        if (quickSelectionOverlayRef.current) {
            return quickSelectionOverlayRef.current;
        }

        const polygon = new fabric.Polygon(
            [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }],
            {
                fill: 'rgba(0, 212, 255, 0.08)',
                stroke: '#00d4ff',
                strokeWidth: 1.5,
                strokeDashArray: [6, 4],
                selectable: false,
                evented: false,
                hasControls: false,
                hasBorders: false,
                objectCaching: false,
                excludeFromExport: true,
                visible: false,
                editorRole: 'quick-select-overlay'
            }
        );

        fabricCanvas.add(polygon);
        quickSelectionOverlayRef.current = polygon;
        polygon.bringToFront();
        return polygon;
    };

    const updateQuickSelectionOverlay = (points, isDraft = false) => {
        const overlay = ensureQuickSelectionOverlay();
        if (!overlay || !Array.isArray(points) || points.length < 2) {
            return;
        }

        const overlayPoints = points.map((point) => ({ x: point.x, y: point.y }));
        if (overlayPoints.length < 3) {
            overlayPoints.push({ ...overlayPoints[overlayPoints.length - 1] });
        }
        overlay.set({
            points: overlayPoints,
            fill: isDraft ? 'rgba(0, 212, 255, 0.03)' : 'rgba(0, 212, 255, 0.08)',
            visible: brushModeRef.current === QUICK_SELECT_MODE
        });
        overlay.setCoords();
        overlay.bringToFront();
        fabricCanvas?.requestRenderAll();
    };

    const clearQuickSelectionDraft = () => {
        quickSelectionDraftPointsRef.current = [];
    };

    const setQuickSelection = (points) => {
        const normalizedPoints = Array.isArray(points)
            ? points.map((point) => ({ x: Math.round(point.x), y: Math.round(point.y) }))
            : [];
        const bounds = calculateQuickSelectionBounds(normalizedPoints);

        if (!bounds) {
            quickSelectionRef.current = null;
            const overlay = quickSelectionOverlayRef.current;
            if (overlay) {
                overlay.set({ visible: false });
                fabricCanvas?.requestRenderAll();
            }
            return;
        }

        quickSelectionRef.current = {
            points: normalizedPoints,
            bounds
        };
        updateQuickSelectionOverlay(normalizedPoints, false);
    };

    const renderQuickSelectionCanvas = (selection) => {
        if (!fabricCanvas || !genFrame || !selection?.bounds || !selection?.points?.length) {
            return null;
        }

        const bounds = selection.bounds;
        const exportCanvas = fabric.util.createCanvasElement();
        exportCanvas.width = bounds.width;
        exportCanvas.height = bounds.height;
        const context = exportCanvas.getContext('2d');
        if (!context) {
            return null;
        }

        context.save();
        context.beginPath();
        selection.points.forEach((point, index) => {
            const localX = point.x - bounds.left;
            const localY = point.y - bounds.top;
            if (index === 0) {
                context.moveTo(localX, localY);
            } else {
                context.lineTo(localX, localY);
            }
        });
        context.closePath();
        context.clip();

        const rasterObjects = fabricCanvas.getObjects().filter((object) => (
            object.visible !== false
            && (isBaseRasterObject(object, genFrame) || isCandidateObject(object, genFrame))
        ));
        if (rasterObjects.length === 0) {
            context.restore();
            return null;
        }

        rasterObjects.forEach((object) => {
            const originalCanvas = object.canvas;
            const originalDirty = object.dirty;
            try {
                object.canvas = null;
                context.save();
                context.translate(-bounds.left, -bounds.top);
                object.render(context);
                context.restore();
            } finally {
                object.canvas = originalCanvas;
                object.dirty = originalDirty;
            }
        });

        context.restore();
        return hasVisiblePixels(exportCanvas) ? exportCanvas : null;
    };

    const copyQuickSelection = async () => {
        const selection = quickSelectionRef.current;
        if (!selection) {
            return false;
        }

        const selectionCanvas = renderQuickSelectionCanvas(selection);
        if (!selectionCanvas) {
            return false;
        }

        quickClipboardRef.current = {
            dataUrl: selectionCanvas.toDataURL('image/png'),
            width: selection.bounds.width,
            height: selection.bounds.height
        };
        return true;
    };

    const pasteQuickSelection = async () => {
        if (!fabricCanvas || !genFrame || !quickClipboardRef.current) {
            return false;
        }

        const clipboard = quickClipboardRef.current;
        const sourceSelection = quickSelectionRef.current;
        const frameBounds = getFrameBounds();
        if (!frameBounds) {
            return false;
        }

        return await new Promise((resolve, reject) => {
            fabric.Image.fromURL(clipboard.dataUrl, (image) => {
                if (!image) {
                    reject(new Error('Failed to decode copied selection.'));
                    return;
                }

                const width = Math.max(1, clipboard.width || image.width || 1);
                const height = Math.max(1, clipboard.height || image.height || 1);
                const offset = 28;
                const leftBase = sourceSelection?.bounds?.left ?? frameBounds.left;
                const topBase = sourceSelection?.bounds?.top ?? frameBounds.top;
                const left = Math.max(frameBounds.left, Math.min(frameBounds.right - width, leftBase + offset));
                const top = Math.max(frameBounds.top, Math.min(frameBounds.bottom - height, topBase + offset));

                image.set({
                    left,
                    top,
                    originX: 'left',
                    originY: 'top',
                    scaleX: width / Math.max(1, image.width || width),
                    scaleY: height / Math.max(1, image.height || height),
                    objectCaching: false,
                    noScaleCache: false,
                    selectable: true,
                    evented: true,
                    hasControls: true,
                    lockRotation: true,
                    isCandidate: true,
                    editorRole: CANVAS_OBJECT_ROLES.CANDIDATE,
                    candidateSourceUrl: null,
                    stroke: CANVAS_DEFAULTS.CANDIDATE_BORDER_COLOR,
                    strokeWidth: 4,
                    hoverCursor: 'move'
                });

                if (candidateRef.current) {
                    fabricCanvas.remove(candidateRef.current);
                    setCandidateState(null, null);
                }

                image.setCoords();
                fabricCanvas.add(image);
                fabricCanvas.setActiveObject(image);
                setCandidateState(image, null);
                syncCanvasInteractionMode();
                commitUndoSnapshot(getUndoSnapshotParams(fabricCanvas, genFrame));
                resolve(true);
            }, { crossOrigin: 'anonymous' });
        });
    };

    const exportForQuickSelectRefine = async () => {
        if (!fabricCanvas || !genFrame || !quickSelectionRef.current) {
            return null;
        }

        const frameLeft = genFrame.left ?? 0;
        const frameTop = genFrame.top ?? 0;
        const frameWidth = Math.max(1, Math.round((genFrame.width ?? 0) * (genFrame.scaleX ?? 1)));
        const frameHeight = Math.max(1, Math.round((genFrame.height ?? 0) * (genFrame.scaleY ?? 1)));
        const rawSelection = quickSelectionRef.current.bounds;
        const selectionLeft = Math.max(0, Math.min(frameWidth - 1, Math.round(rawSelection.left - frameLeft)));
        const selectionTop = Math.max(0, Math.min(frameHeight - 1, Math.round(rawSelection.top - frameTop)));
        const selectionWidth = Math.max(1, Math.min(frameWidth - selectionLeft, Math.round(rawSelection.width)));
        const selectionHeight = Math.max(1, Math.min(frameHeight - selectionTop, Math.round(rawSelection.height)));
        const { image, width, height } = await exportCanvasState(fabricCanvas, genFrame);

        const maskCanvas = fabric.util.createCanvasElement();
        maskCanvas.width = frameWidth;
        maskCanvas.height = frameHeight;
        const maskContext = maskCanvas.getContext('2d');
        if (!maskContext) {
            throw new Error('Failed to build quick-select mask.');
        }
        maskContext.fillStyle = 'black';
        maskContext.fillRect(0, 0, frameWidth, frameHeight);
        maskContext.fillStyle = 'white';
        maskContext.beginPath();
        quickSelectionRef.current.points.forEach((point, index) => {
            const localX = point.x - frameLeft;
            const localY = point.y - frameTop;
            if (index === 0) {
                maskContext.moveTo(localX, localY);
            } else {
                maskContext.lineTo(localX, localY);
            }
        });
        maskContext.closePath();
        maskContext.fill();
        const mask = await canvasToBlob(maskCanvas, 'image/png');

        return {
            image,
            mask,
            width,
            height,
            selection: {
                left: selectionLeft,
                top: selectionTop,
                width: selectionWidth,
                height: selectionHeight
            }
        };
    };

    const exportBaseRasterFrameImage = async () => {
        if (!fabricCanvas || !genFrame) {
            throw new Error('Canvas is not ready for export.');
        }

        const frameLeft = genFrame.left ?? 0;
        const frameTop = genFrame.top ?? 0;
        const frameWidth = Math.max(1, Math.round((genFrame.width ?? 0) * (genFrame.scaleX ?? 1)));
        const frameHeight = Math.max(1, Math.round((genFrame.height ?? 0) * (genFrame.scaleY ?? 1)));

        const exportCanvas = fabric.util.createCanvasElement();
        exportCanvas.width = frameWidth;
        exportCanvas.height = frameHeight;
        const context = exportCanvas.getContext('2d');
        if (!context) {
            throw new Error('Failed to create export context.');
        }

        const rasterObjects = fabricCanvas.getObjects().filter((object) => (
            object.visible !== false
            && isBaseRasterObject(object, genFrame)
        ));

        rasterObjects.forEach((object) => {
            const originalCanvas = object.canvas;
            const originalDirty = object.dirty;
            try {
                object.canvas = null;
                context.save();
                context.translate(-frameLeft, -frameTop);
                object.render(context);
                context.restore();
            } finally {
                object.canvas = originalCanvas;
                object.dirty = originalDirty;
            }
        });

        const image = await canvasToBlob(exportCanvas, 'image/png');
        return {
            image,
            width: frameWidth,
            height: frameHeight
        };
    };

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

        const { image, width, height } = await exportBaseRasterFrameImage();
        const frameWidth = width;
        const frameHeight = height;
        const frameLeft = genFrame.left ?? 0;
        const frameTop = genFrame.top ?? 0;
        const safeRadius = Math.max(4, Math.min(192, Number(radius || (brushSizeRef.current || 8) / 2)));
        const safeX = Math.min(frameLeft + frameWidth - 1, Math.max(frameLeft, Number(x ?? frameLeft)));
        const safeY = Math.min(frameTop + frameHeight - 1, Math.max(frameTop, Number(y ?? frameTop)));
        const localX = safeX - frameLeft;
        const localY = safeY - frameTop;

        const maskCanvas = fabric.util.createCanvasElement();
        maskCanvas.width = frameWidth;
        maskCanvas.height = frameHeight;
        const maskContext = maskCanvas.getContext('2d');
        if (!maskContext) {
            throw new Error('Failed to build spot-heal mask.');
        }
        maskContext.fillStyle = 'black';
        maskContext.fillRect(0, 0, frameWidth, frameHeight);
        maskContext.fillStyle = 'white';
        maskContext.beginPath();
        maskContext.arc(localX, localY, safeRadius, 0, Math.PI * 2);
        maskContext.fill();

        const mask = await canvasToBlob(maskCanvas, 'image/png');
        return {
            image,
            mask,
            width: frameWidth,
            height: frameHeight
        };
    };

    const getFrameRect = () => {
        if (!genFrame) {
            return null;
        }
        return {
            left: genFrame.left ?? 0,
            top: genFrame.top ?? 0,
            width: Math.max(1, Math.round((genFrame.width ?? 0) * (genFrame.scaleX ?? 1))),
            height: Math.max(1, Math.round((genFrame.height ?? 0) * (genFrame.scaleY ?? 1)))
        };
    };

    const renderFrameCompositeImageData = () => {
        if (!fabricCanvas || !genFrame) {
            return null;
        }
        const frameRect = getFrameRect();
        const compositeCanvas = fabric.util.createCanvasElement();
        compositeCanvas.width = frameRect.width;
        compositeCanvas.height = frameRect.height;
        const context = compositeCanvas.getContext('2d', { willReadFrequently: true });
        if (!context) {
            return null;
        }

        const rasterObjects = fabricCanvas.getObjects().filter((object) => (
            object.visible !== false
            && (isBaseRasterObject(object, genFrame) || isCandidateObject(object, genFrame))
        ));
        if (rasterObjects.length === 0) {
            return null;
        }

        rasterObjects.forEach((object) => {
            const originalCanvas = object.canvas;
            const originalDirty = object.dirty;
            try {
                object.canvas = null;
                context.save();
                context.translate(-frameRect.left, -frameRect.top);
                object.render(context);
                context.restore();
            } finally {
                object.canvas = originalCanvas;
                object.dirty = originalDirty;
            }
        });

        return context.getImageData(0, 0, frameRect.width, frameRect.height);
    };

    const buildSelectionPathString = (loops) => loops
        .map((loop) => `M ${loop.map((point) => `${point.x} ${point.y}`).join(' L ')} Z`)
        .join(' ');

    const stopSelectionAntsAnimation = () => {
        if (selectionAntsTimerRef.current) {
            window.clearInterval(selectionAntsTimerRef.current);
            selectionAntsTimerRef.current = null;
        }
    };

    const removeSelectionOverlay = () => {
        if (!fabricCanvas) {
            return;
        }
        fabricCanvas.getObjects()
            .filter((object) => object.editorRole === 'selection-overlay')
            .forEach((object) => fabricCanvas.remove(object));
        selectionOverlayRef.current = null;
    };

    const updateSelectionOverlay = () => {
        if (!fabricCanvas) {
            return;
        }
        removeSelectionOverlay();

        const selection = selectionRef.current;
        const loops = selection ? traceSelectionOutline(selection) : [];
        if (loops.length === 0) {
            stopSelectionAntsAnimation();
            fabricCanvas.requestRenderAll();
            return;
        }

        const overlay = new fabric.Path(buildSelectionPathString(loops), {
            fill: 'rgba(0, 212, 255, 0.07)',
            fillRule: 'evenodd',
            stroke: '#00d4ff',
            strokeWidth: 1.2,
            strokeUniform: true,
            strokeDashArray: [5, 4],
            selectable: false,
            evented: false,
            hasControls: false,
            hasBorders: false,
            objectCaching: false,
            excludeFromExport: true,
            editorRole: 'selection-overlay'
        });
        fabricCanvas.add(overlay);
        overlay.bringToFront();
        selectionOverlayRef.current = overlay;

        // «Муравьи»: медленный интервал, чтобы не перерисовывать все слои
        // каждый кадр (objectCaching у изображений выключен).
        if (!selectionAntsTimerRef.current) {
            selectionAntsTimerRef.current = window.setInterval(() => {
                const antsOverlay = selectionOverlayRef.current;
                if (!antsOverlay || !fabricCanvas) {
                    return;
                }
                antsOverlay.set({ strokeDashOffset: ((antsOverlay.strokeDashOffset || 0) + 2) % 9 });
                fabricCanvas.requestRenderAll();
            }, 150);
        }
        fabricCanvas.requestRenderAll();
    };

    const applyIncomingSelection = (incoming, operation = 'replace') => {
        selectionRef.current = combineSelections(selectionRef.current, incoming, operation);
        updateSelectionOverlay();
    };

    const deselectSelection = () => {
        if (!selectionRef.current) {
            return false;
        }
        selectionRef.current = null;
        updateSelectionOverlay();
        return true;
    };

    const invertActiveSelection = () => {
        const frameRect = getFrameRect();
        if (!frameRect) {
            return false;
        }
        selectionRef.current = invertSelection(selectionRef.current, frameRect);
        updateSelectionOverlay();
        return true;
    };

    const featherActiveSelection = (radius) => {
        if (!selectionRef.current) {
            return false;
        }
        selectionRef.current = featherSelection(selectionRef.current, radius);
        updateSelectionOverlay();
        return true;
    };

    const convertSelectionToInpaintMask = () => {
        const selection = selectionRef.current;
        if (!selection || !fabricCanvas || !genFrame) {
            return false;
        }
        const loops = traceSelectionOutline(selection);
        if (loops.length === 0) {
            return false;
        }

        const maskPath = new fabric.Path(buildSelectionPathString(loops), {
            fill: 'rgba(255, 0, 0, 1.0)',
            fillRule: 'evenodd',
            stroke: null,
            editorRole: CANVAS_OBJECT_ROLES.MASK,
            isMask: true,
            selectable: false,
            evented: false,
            opacity: 1.0
        });

        let maskGroup = getMaskGroupFromCanvas(fabricCanvas);
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
        }
        maskGroup.addWithUpdate(maskPath);
        markUndoDirty(maskGroup);
        if (candidateRef.current && !maskOverlayVisibleRef.current) {
            maskGroup.set({ visible: false });
        }
        enforceCanvasLayerOrder(fabricCanvas, genFrame);
        syncMaskStateFromCanvas(fabricCanvas);
        applyMaskFeatherPreview(fabricCanvas);
        fabricCanvas.requestRenderAll();
        commitUndoSnapshot(getUndoSnapshotParams(fabricCanvas, genFrame));
        return true;
    };

    useEffect(() => () => stopSelectionAntsAnimation(), []);

    // --- Коррекции и фильтры ---
    const resolveAdjustmentTarget = () => {
        if (!fabricCanvas || !genFrame) {
            return null;
        }
        const activeObject = fabricCanvas.getActiveObject();
        if (
            activeObject
            && activeObject.type === 'image'
            && activeObject.editorLayerLocked !== true
            && (isBaseRasterObject(activeObject, genFrame) || isCandidateObject(activeObject, genFrame))
        ) {
            return activeObject;
        }
        return [...fabricCanvas.getObjects()].reverse().find((object) => (
            object.visible !== false
            && object.type === 'image'
            && object.editorLayerLocked !== true
            && isBaseRasterObject(object, genFrame)
        )) || null;
    };

    const finishAdjustmentCommit = (target) => {
        markUndoDirty(target);
        commitUndoSnapshot(getUndoSnapshotParams(fabricCanvas, genFrame));
    };

    const closeAdjustment = () => {
        adjustmentSessionRef.current = null;
        setActiveAdjustment(null);
    };

    const handleAdjustmentApply = (params) => {
        const session = adjustmentSessionRef.current;
        if (!session || !activeAdjustment) {
            return;
        }
        session.commit(activeAdjustment.type, params);
        finishAdjustmentCommit(session.targetObject);
        closeAdjustment();
    };

    const handleAdjustmentCancel = () => {
        adjustmentSessionRef.current?.cancel();
        closeAdjustment();
    };

    const handleAdjustmentPreview = (params) => {
        if (!activeAdjustment) {
            return;
        }
        adjustmentSessionRef.current?.update(activeAdjustment.type, params);
    };

    const openAdjustment = (type) => {
        if (!fabricCanvas || !genFrame) {
            return { ok: false, reason: 'not-ready' };
        }
        if (candidateRef.current) {
            return { ok: false, reason: 'candidate' };
        }
        if (adjustmentSessionRef.current) {
            return { ok: false, reason: 'busy' };
        }

        const target = resolveAdjustmentTarget();
        if (!target) {
            return { ok: false, reason: 'no-target' };
        }

        const session = createAdjustmentSession({
            canvas: fabricCanvas,
            targetObject: target,
            selection: selectionRef.current
        });
        if (!session) {
            return { ok: false, reason: 'no-target' };
        }

        if (type === ADJUSTMENT_TYPES.INVERT) {
            session.commit(type, {});
            finishAdjustmentCommit(target);
            return { ok: true, instant: true };
        }

        adjustmentSessionRef.current = session;
        setActiveAdjustment({ type });
        return { ok: true };
    };

    // --- Заливка, градиент, пипетка ---
    const hexToRgb = (hex) => {
        const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
        if (!match) {
            return { r: 0, g: 0, b: 0 };
        }
        const value = parseInt(match[1], 16);
        return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
    };

    const sampleCompositeColor = (point) => {
        if (!fabricCanvas || !genFrame) {
            return null;
        }
        const sampleCanvas = fabric.util.createCanvasElement();
        sampleCanvas.width = 1;
        sampleCanvas.height = 1;
        const context = sampleCanvas.getContext('2d', { willReadFrequently: true });
        if (!context) {
            return null;
        }

        const contentObjects = fabricCanvas.getObjects().filter((object) => (
            object.visible !== false
            && object !== genFrame
            && object.editorRole !== CANVAS_OBJECT_ROLES.FRAME
            && object.editorRole !== CANVAS_OBJECT_ROLES.FRAME_HIT_AREA
            && !UI_OVERLAY_ROLES.includes(object.editorRole)
            && !isMaskObject(object, genFrame)
        ));

        contentObjects.forEach((object) => {
            const originalCanvas = object.canvas;
            const originalDirty = object.dirty;
            try {
                object.canvas = null;
                context.save();
                context.translate(-Math.round(point.x), -Math.round(point.y));
                object.render(context);
                context.restore();
            } finally {
                object.canvas = originalCanvas;
                object.dirty = originalDirty;
            }
        });

        const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
        if (a === 0) {
            return null;
        }
        const toHex = (channel) => channel.toString(16).padStart(2, '0');
        return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    };

    const handleEyedropperPoint = (point) => {
        const hex = sampleCompositeColor(point);
        if (hex) {
            setBrushColorRef.current?.(hex);
        } else {
            onToolNotifyRef.current?.('Под пипеткой нет пикселей.');
        }
    };

    const resolvePixelToolTarget = () => {
        if (candidateRef.current) {
            onToolNotifyRef.current?.('Сначала прими или отмени сгенерированного кандидата.');
            return null;
        }
        const target = resolveAdjustmentTarget();
        if (!target) {
            onToolNotifyRef.current?.('Нет растрового слоя для этой операции.');
            return null;
        }
        if (!ensureWritableCanvasElement(target)) {
            return null;
        }
        return target;
    };

    const commitPixelToolResult = (target, workCanvas) => {
        target.setElement(workCanvas);
        // Новый asset id — иначе мутация элемента портит старые undo-снапшоты.
        target.set({ assetId: null, dirty: true });
        markUndoDirty(target);
        commitUndoSnapshot(getUndoSnapshotParams(fabricCanvas, genFrame));
        fabricCanvas.requestRenderAll();
    };

    const handleFillPoint = (point) => {
        const target = resolvePixelToolTarget();
        if (!target) {
            return;
        }
        const element = target.getElement();
        const width = element.width;
        const height = element.height;
        const selection = selectionRef.current;

        let localMask = null;
        if (selection && sampleSelectionAt(selection, point.x, point.y) > 0) {
            localMask = sampleMaskForLayer(selection, target, width, height);
            if (!localMask) {
                onToolNotifyRef.current?.('Выделение не пересекает активный слой.');
                return;
            }
        } else {
            const local = worldPointToLocal(target, point);
            if (local.x < 0 || local.y < 0 || local.x >= width || local.y >= height) {
                onToolNotifyRef.current?.('Клик вне активного слоя.');
                return;
            }
            const context = element.getContext('2d', { willReadFrequently: true });
            const imageData = context.getImageData(0, 0, width, height);
            const wandSelection = magicWandMask(
                { data: imageData.data, width, height },
                local.x,
                local.y,
                { tolerance: fillToleranceRef.current }
            );
            if (!wandSelection) {
                return;
            }
            localMask = new Uint8ClampedArray(width * height);
            for (let y = 0; y < wandSelection.height; y += 1) {
                const sourceOffset = y * wandSelection.width;
                const targetOffset = (y + wandSelection.top) * width + wandSelection.left;
                localMask.set(
                    wandSelection.mask.subarray(sourceOffset, sourceOffset + wandSelection.width),
                    targetOffset
                );
            }
        }

        const workCanvas = cloneCanvasElement(element);
        const workContext = workCanvas.getContext('2d', { willReadFrequently: true });
        const imageData = workContext.getImageData(0, 0, width, height);
        const { data } = imageData;
        const { r, g, b } = hexToRgb(brushColorRef.current);

        for (let pixel = 0; pixel < localMask.length; pixel += 1) {
            const coverage = localMask[pixel] / 255;
            if (coverage === 0) {
                continue;
            }
            const offset = pixel * 4;
            const dstAlpha = data[offset + 3] / 255;
            const outAlpha = coverage + dstAlpha * (1 - coverage);
            if (outAlpha === 0) {
                continue;
            }
            data[offset] = (r * coverage + data[offset] * dstAlpha * (1 - coverage)) / outAlpha;
            data[offset + 1] = (g * coverage + data[offset + 1] * dstAlpha * (1 - coverage)) / outAlpha;
            data[offset + 2] = (b * coverage + data[offset + 2] * dstAlpha * (1 - coverage)) / outAlpha;
            data[offset + 3] = outAlpha * 255;
        }

        workContext.putImageData(imageData, 0, 0);
        commitPixelToolResult(target, workCanvas);
    };

    const handleGradientApply = (start, end) => {
        const target = resolvePixelToolTarget();
        if (!target) {
            return;
        }
        const element = target.getElement();
        const width = element.width;
        const height = element.height;

        const overlayCanvas = fabric.util.createCanvasElement();
        overlayCanvas.width = width;
        overlayCanvas.height = height;
        const overlayContext = overlayCanvas.getContext('2d', { willReadFrequently: true });

        const localStart = worldPointToLocal(target, start);
        const localEnd = worldPointToLocal(target, end);
        const { r, g, b } = hexToRgb(brushColorRef.current);
        const options = gradientOptionsRef.current || {};
        const gradient = overlayContext.createLinearGradient(localStart.x, localStart.y, localEnd.x, localEnd.y);
        gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, 1)`);
        if (options.toTransparent) {
            gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
        } else {
            const endColor = hexToRgb(options.endColor || '#000000');
            gradient.addColorStop(1, `rgba(${endColor.r}, ${endColor.g}, ${endColor.b}, 1)`);
        }
        overlayContext.fillStyle = gradient;
        overlayContext.fillRect(0, 0, width, height);

        const selection = selectionRef.current;
        if (selection) {
            const localMask = sampleMaskForLayer(selection, target, width, height);
            if (!localMask) {
                onToolNotifyRef.current?.('Выделение не пересекает активный слой.');
                return;
            }
            const overlayData = overlayContext.getImageData(0, 0, width, height);
            for (let pixel = 0; pixel < localMask.length; pixel += 1) {
                overlayData.data[pixel * 4 + 3] = (overlayData.data[pixel * 4 + 3] * localMask[pixel]) / 255;
            }
            overlayContext.putImageData(overlayData, 0, 0);
        }

        const workCanvas = cloneCanvasElement(element);
        workCanvas.getContext('2d').drawImage(overlayCanvas, 0, 0);
        commitPixelToolResult(target, workCanvas);
    };

    // --- Кадрирование и трансформации документа ---
    const updateCropOverlay = (rect) => {
        if (!fabricCanvas) {
            return;
        }
        fabricCanvas.getObjects()
            .filter((object) => object.editorRole === 'crop-overlay')
            .forEach((object) => fabricCanvas.remove(object));

        if (rect) {
            const HUGE = 100000;
            const right = rect.left + rect.width;
            const bottom = rect.top + rect.height;
            const overlay = new fabric.Path(
                `M ${-HUGE} ${-HUGE} L ${HUGE} ${-HUGE} L ${HUGE} ${HUGE} L ${-HUGE} ${HUGE} Z `
                + `M ${rect.left} ${rect.top} L ${right} ${rect.top} L ${right} ${bottom} L ${rect.left} ${bottom} Z`,
                {
                    fill: 'rgba(0, 0, 0, 0.45)',
                    fillRule: 'evenodd',
                    stroke: '#ffffff',
                    strokeWidth: 1.2,
                    strokeUniform: true,
                    strokeDashArray: [6, 4],
                    selectable: false,
                    evented: false,
                    hasControls: false,
                    hasBorders: false,
                    objectCaching: false,
                    excludeFromExport: true,
                    editorRole: 'crop-overlay'
                }
            );
            fabricCanvas.add(overlay);
            overlay.bringToFront();
        }
        fabricCanvas.requestRenderAll();
    };

    const cancelCropAction = () => {
        cropRectRef.current = null;
        updateCropOverlay(null);
    };

    const applyCropRect = (rect) => setGenerationFrameRect({
        rect,
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
    });

    const applyCropAction = () => {
        const rect = cropRectRef.current;
        if (!rect) {
            onToolNotifyRef.current?.('Сначала выдели область кадрирования.');
            return false;
        }
        const applied = applyCropRect(rect);
        cancelCropAction();
        return applied;
    };

    const cropToSelectionAction = () => {
        const selection = selectionRef.current;
        if (!selection) {
            onToolNotifyRef.current?.('Сначала создай выделение.');
            return false;
        }
        cancelCropAction();
        return applyCropRect({
            left: selection.left,
            top: selection.top,
            width: selection.width,
            height: selection.height
        });
    };

    const flipActiveObject = (axis) => {
        if (!fabricCanvas || !genFrame) {
            return false;
        }
        const activeObject = fabricCanvas.getActiveObject();
        const target = (
            activeObject
            && activeObject !== genFrame
            && isLayerPanelObject(activeObject)
            && activeObject.editorLayerLocked !== true
        ) ? activeObject : resolveAdjustmentTarget();
        if (!target) {
            onToolNotifyRef.current?.('Нет слоя для отражения.');
            return false;
        }
        if (axis === 'y') {
            target.set({ flipY: !target.flipY });
        } else {
            target.set({ flipX: !target.flipX });
        }
        target.setCoords();
        markUndoDirty(target);
        commitUndoSnapshot(getUndoSnapshotParams(fabricCanvas, genFrame));
        fabricCanvas.requestRenderAll();
        return true;
    };

    useEffect(() => {
        if (brushMode !== TOOL_MODES.CROP && cropRectRef.current) {
            cancelCropAction();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [brushMode]);

    useEffect(() => {
        if (!fabricCanvas || !genFrame) {
            return undefined;
        }
        return setupCropToolHandling({
            canvas: fabricCanvas,
            brushModeRef,
            onCropDraft: (rect) => updateCropOverlay(rect),
            onCropCommit: (rect) => {
                cropRectRef.current = rect;
                updateCropOverlay(rect);
            }
        });
    }, [fabricCanvas, genFrame]);

    useEffect(() => {
        if (!fabricCanvas || !genFrame) {
            return undefined;
        }
        return setupDrawingToolHandling({
            canvas: fabricCanvas,
            frameObject: genFrame,
            brushModeRef,
            brushColorRef,
            setBrushModeRef,
            textOptionsRef,
            shapeOptionsRef,
            clampPointToFrame,
            canvasObjectRoles: CANVAS_OBJECT_ROLES,
            enforceCanvasLayerOrder,
            markUndoDirty,
            commitUndoSnapshot,
            getUndoSnapshotParams,
            onFillPoint: handleFillPoint,
            onGradientApply: handleGradientApply,
            onEyedropperPoint: handleEyedropperPoint
        });
    }, [fabricCanvas, genFrame]);

    useEffect(() => {
        if (!fabricCanvas || !genFrame) {
            return undefined;
        }
        return setupSelectionToolHandling({
            canvas: fabricCanvas,
            brushModeRef,
            clampPointToFrame,
            getFrameBounds: getFrameRect,
            renderFrameImageData: renderFrameCompositeImageData,
            magicWandToleranceRef,
            applySelection: applyIncomingSelection
        });
    }, [fabricCanvas, genFrame]);

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

        copyQuickSelection,

        pasteQuickSelection,

        hasQuickSelection: () => Boolean(quickSelectionRef.current),

        hasQuickClipboard: () => Boolean(quickClipboardRef.current),

        getSelection: () => selectionRef.current,

        hasSelection: () => Boolean(selectionRef.current),

        deselectSelection,

        invertSelection: invertActiveSelection,

        featherSelection: featherActiveSelection,

        convertSelectionToInpaintMask,

        setMaskFeatherPreview,

        setMagicWandTolerance: (value) => {
            magicWandToleranceRef.current = Math.max(0, Math.min(255, Number(value) || 0));
        },

        openAdjustment,

        setTextOptions: (patch) => {
            textOptionsRef.current = { ...textOptionsRef.current, ...patch };
        },

        setShapeOptions: (patch) => {
            shapeOptionsRef.current = { ...shapeOptionsRef.current, ...patch };
        },

        setFillTolerance: (value) => {
            fillToleranceRef.current = Math.max(0, Math.min(255, Number(value) || 0));
        },

        setGradientOptions: (patch) => {
            gradientOptionsRef.current = { ...gradientOptionsRef.current, ...patch };
        },

        applyCrop: applyCropAction,

        cancelCrop: cancelCropAction,

        cropToSelection: cropToSelectionAction,

        flipActiveObject,

        getFrameSize: () => {
            const frameRect = getFrameRect();
            return frameRect ? { width: frameRect.width, height: frameRect.height } : null;
        },

        resizeImage: (width, height) => {
            if (!(width >= 1) || !(height >= 1)) {
                return false;
            }
            return resizeDocumentImage({
                width,
                height,
                fabricCanvas,
                genFrame,
                genFrameVisual: genFrameVisualRef.current,
                isLayerContentObject: isLayerPanelObject,
                syncFrameVisualState,
                setGenDimensions,
                enforceCanvasLayerOrder,
                syncCanvasInteractionMode,
                markUndoDirty,
                commitUndoSnapshot,
                getUndoSnapshotParams
            });
        },

        resizeCanvas: (width, height, anchorX = 0.5, anchorY = 0.5) => {
            if (!(width >= 1) || !(height >= 1)) {
                return false;
            }
            return resizeDocumentCanvas({
                width,
                height,
                anchorX,
                anchorY,
                fabricCanvas,
                genFrame,
                genFrameVisual: genFrameVisualRef.current,
                syncFrameVisualState,
                setGenDimensions,
                enforceCanvasLayerOrder,
                syncCanvasInteractionMode,
                markUndoDirty,
                commitUndoSnapshot,
                getUndoSnapshotParams
            });
        },

        exportForQuickSelectRefine,

        getLayers: () => buildLayersSnapshot(),

        selectLayer,

        addLayer,

        toggleLayerVisibility,

        toggleLayerLock,

        updateLayerStyle,

        hasPendingCandidate: () => Boolean(candidateRef.current),

        importImage: async (file) => {
            const img = await importImageToCanvas(fabricCanvas, file);
            enforceCanvasLayerOrder(fabricCanvas, genFrame);
            commitUndoSnapshot(getUndoSnapshotParams());
            return img;
        },

        importImageFromUrl: async (url) => {
            const img = await importImageFromUrl(fabricCanvas, url);
            enforceCanvasLayerOrder(fabricCanvas, genFrame);
            commitUndoSnapshot(getUndoSnapshotParams());
            return img;
        },

        exportCanvas: (options) => exportCanvasAsFile(fabricCanvas, genFrame, options),

        exportHistorySnapshot: async () => exportDocumentSnapshot(fabricCanvas, genFrame),

        restoreHistoryDocument: async (url) => {
            // Выделение относится к старому документу — снимаем.
            deselectSelection();
            return restoreHistoryDocument({
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
            });
        },

        undo: performUndo,

        clearAll: () => {
            clearEditorOverlays({
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
            });
            // Превью-кромка — отдельный оверлей (не isMaskObject), очисткой выше
            // не удаляется; пересчитываем превью — без маски оно само снимется.
            applyMaskFeatherPreview();
        }
    }));

    const performUndoRef = useRef(performUndo);
    const setBrushModeRef = useRef(setBrushMode);
    const copyQuickSelectionRef = useRef(copyQuickSelection);
    const pasteQuickSelectionRef = useRef(pasteQuickSelection);
    const performDeleteActiveObjectRef = useRef(performDeleteActiveObject);
    const syncCanvasInteractionModeRef = useRef(syncCanvasInteractionMode);
    const deselectSelectionRef = useRef(deselectSelection);
    const applyCropActionRef = useRef(applyCropAction);
    const cancelCropActionRef = useRef(cancelCropAction);
    useEffect(() => {
        performUndoRef.current = performUndo;
        setBrushModeRef.current = setBrushMode;
        copyQuickSelectionRef.current = copyQuickSelection;
        pasteQuickSelectionRef.current = pasteQuickSelection;
        performDeleteActiveObjectRef.current = performDeleteActiveObject;
        syncCanvasInteractionModeRef.current = syncCanvasInteractionMode;
        deselectSelectionRef.current = deselectSelection;
        applyCropActionRef.current = applyCropAction;
        cancelCropActionRef.current = cancelCropAction;
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
            copyQuickSelectionRef,
            pasteQuickSelectionRef,
            performUndoRef,
            performDeleteActiveObjectRef,
            syncCanvasInteractionModeRef,
            deselectSelectionRef,
            applyCropActionRef,
            cancelCropActionRef
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
        const wrapper = wrapperRef.current;
        if (!wrapper || !fabricCanvas || !genFrame) return undefined;

        const handleDragOver = (e) => {
            const hasFiles = e.dataTransfer.types.includes('Files');
            const hasUri = e.dataTransfer.types.includes('text/uri-list');
            if (!hasFiles && !hasUri) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            setIsDragOver(true);
        };

        const handleDragLeave = (e) => {
            if (!wrapper.contains(e.relatedTarget)) {
                setIsDragOver(false);
            }
        };

        const handleDrop = async (e) => {
            e.preventDefault();
            setIsDragOver(false);

            const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
            if (files.length > 0) {
                for (const file of files) {
                    await importImageToCanvas(fabricCanvas, file);
                }
                enforceCanvasLayerOrder(fabricCanvas, genFrame);
                commitUndoSnapshot(getUndoSnapshotParams());
                return;
            }

            const uriList = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
            if (uriList) {
                const url = uriList.split('\n').find((line) => !line.startsWith('#') && line.trim());
                if (url) {
                    await importImageFromUrl(fabricCanvas, url.trim());
                    enforceCanvasLayerOrder(fabricCanvas, genFrame);
                    commitUndoSnapshot(getUndoSnapshotParams());
                }
            }
        };

        wrapper.addEventListener('dragover', handleDragOver);
        wrapper.addEventListener('dragleave', handleDragLeave);
        wrapper.addEventListener('drop', handleDrop);

        return () => {
            wrapper.removeEventListener('dragover', handleDragOver);
            wrapper.removeEventListener('dragleave', handleDragLeave);
            wrapper.removeEventListener('drop', handleDrop);
        };
    }, [fabricCanvas, genFrame]);

    useEffect(() => {
        if (!fabricCanvas || !genFrame) {
            return undefined;
        }

        let isSelecting = false;

        const handleMouseDown = (event) => {
            if (brushModeRef.current !== QUICK_SELECT_MODE || event.e.button !== 0) {
                return;
            }
            const pointer = clampPointToFrame(fabricCanvas.getPointer(event.e));
            if (!pointer) {
                return;
            }

            event.e.preventDefault();
            event.e.stopPropagation();
            isSelecting = true;
            clearQuickSelectionDraft();
            quickSelectionDraftPointsRef.current.push(pointer);
            updateQuickSelectionOverlay(quickSelectionDraftPointsRef.current, true);
        };

        const handleMouseMove = (event) => {
            if (!isSelecting || brushModeRef.current !== QUICK_SELECT_MODE) {
                return;
            }
            const pointer = clampPointToFrame(fabricCanvas.getPointer(event.e));
            if (!pointer) {
                return;
            }
            quickSelectionDraftPointsRef.current.push(pointer);
            updateQuickSelectionOverlay(quickSelectionDraftPointsRef.current, true);
        };

        const handleMouseUp = () => {
            if (!isSelecting) {
                return;
            }
            isSelecting = false;
            const points = quickSelectionDraftPointsRef.current;
            clearQuickSelectionDraft();
            if (!Array.isArray(points) || points.length < 6) {
                setQuickSelection(null);
                return;
            }

            const bounds = calculateQuickSelectionBounds(points);
            if (bounds.width < 6 || bounds.height < 6) {
                setQuickSelection(null);
                return;
            }
            setQuickSelection(points);
        };

        fabricCanvas.on('mouse:down', handleMouseDown);
        fabricCanvas.on('mouse:move', handleMouseMove);
        fabricCanvas.on('mouse:up', handleMouseUp);

        return () => {
            fabricCanvas.off('mouse:down', handleMouseDown);
            fabricCanvas.off('mouse:move', handleMouseMove);
            fabricCanvas.off('mouse:up', handleMouseUp);
        };
    }, [fabricCanvas, genFrame]);

    useEffect(() => {
        const overlay = quickSelectionOverlayRef.current;
        if (!overlay) {
            return;
        }
        overlay.set({
            visible: brushMode === QUICK_SELECT_MODE && Boolean(quickSelectionRef.current)
        });
        if (overlay.visible) {
            overlay.bringToFront();
        }
        fabricCanvas?.requestRenderAll();
    }, [brushMode, fabricCanvas]);

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

            {isDragOver && (
                <div className="editor__drag-overlay">
                    <span className="editor__drag-overlay__label">Отпустите для импорта</span>
                </div>
            )}

            {isCanvasEmpty && !isDragOver && previewFrameBounds?.visible && (
                <div
                    className="editor-empty-state"
                    style={{
                        left: `${previewFrameBounds.left}px`,
                        top: `${previewFrameBounds.top}px`,
                        width: `${previewFrameBounds.width}px`,
                        height: `${previewFrameBounds.height}px`
                    }}
                >
                    <div className="editor-empty-state__inner">
                        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <rect x="3" y="3" width="18" height="18" rx="2" />
                            <circle cx="9" cy="9" r="2" />
                            <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
                        </svg>
                        <span className="editor-empty-state__title">Холст пуст</span>
                        <span className="editor-empty-state__text">
                            Перетащи изображение сюда, импортируй файл<br />
                            или напиши промпт и нажми «Сгенерировать»
                        </span>
                        <span className="editor-empty-state__sub">
                            Колесо — масштаб · Space — панорама · Ctrl+Z — отмена
                        </span>
                    </div>
                </div>
            )}

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

            {activeAdjustment && (
                <AdjustmentsDialog
                    type={activeAdjustment.type}
                    onPreview={handleAdjustmentPreview}
                    onApply={handleAdjustmentApply}
                    onCancel={handleAdjustmentCancel}
                    getHistogram={() => adjustmentSessionRef.current?.getHistogram()}
                    selectionMissesLayer={adjustmentSessionRef.current?.selectionMissesLayer}
                />
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

Editor.displayName = 'Editor';

export default Editor;
