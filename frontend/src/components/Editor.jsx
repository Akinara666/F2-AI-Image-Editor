import React, { useEffect, useRef, useState, useImperativeHandle, forwardRef } from 'react';
import { fabric } from 'fabric';
import {
    applyEraserPathToCanvas,
    bakeCandidateIntoCanvas,
    enforceCanvasLayerOrder,
    exportCanvasState,
    isBaseRasterObject,
    isCandidateObject,
    isMaskObject,
    isSketchObject
} from '../utils/canvasLogic';
import { CANVAS_DEFAULTS, CANVAS_OBJECT_ROLES, createClientId, resolveApiUrl } from '../constants';
import './Editor.css';

const MAX_UNDO_STEPS = 50;
const FRAME_STROKE_WIDTH = 3;
const FRAME_DASH_PATTERN = [10, 5];
const UNDO_SERIALIZED_PROPS = [
    'editorRole',
    'id',
    'isMask',
    'isCandidate',
    'candidateSourceUrl',
    'assetId',
    'selectable',
    'evented',
    'hasControls',
    'hasBorders',
    'lockMovementX',
    'lockMovementY',
    'lockScalingX',
    'lockScalingY',
    'lockRotation',
    'hoverCursor',
    'objectCaching',
    'noScaleCache',
    'perPixelTargetFind',
    'transparentCorners',
    'cornerSize'
];
const UNDO_IMAGE_PROPS = [
    'assetId',
    'editorRole',
    'isCandidate',
    'candidateSourceUrl',
    'left',
    'top',
    'width',
    'height',
    'scaleX',
    'scaleY',
    'angle',
    'flipX',
    'flipY',
    'opacity',
    'visible',
    'originX',
    'originY',
    'stroke',
    'strokeWidth',
    'strokeDashArray',
    'selectable',
    'evented',
    'hasControls',
    'hasBorders',
    'lockMovementX',
    'lockMovementY',
    'lockScalingX',
    'lockScalingY',
    'lockRotation',
    'hoverCursor',
    'objectCaching',
    'noScaleCache',
    'cropX',
    'cropY'
];

const blobToDataURL = (blob) => (
    new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Failed to convert blob to data URL.'));
        reader.readAsDataURL(blob);
    })
);

const snapshotObjectTransform = (object) => ({
    left: object.left,
    top: object.top,
    width: object.width,
    height: object.height,
    scaleX: object.scaleX,
    scaleY: object.scaleY
});

const areTransformsEqual = (left, right) => (
    left.left === right.left
    && left.top === right.top
    && left.width === right.width
    && left.height === right.height
    && left.scaleX === right.scaleX
    && left.scaleY === right.scaleY
);

const serializeFrameState = (object) => ({
    left: object.left,
    top: object.top,
    width: object.width,
    height: object.height,
    scaleX: object.scaleX,
    scaleY: object.scaleY,
    angle: object.angle,
    visible: object.visible
});

const serializeFrameVisualState = (object) => ({
    ...serializeFrameState(object),
    strokeWidth: object.strokeWidth,
    strokeDashArray: Array.isArray(object.strokeDashArray) ? [...object.strokeDashArray] : object.strokeDashArray
});

const applyFrameViewportStyle = (frameVisualObject, zoomLevel) => {
    if (!frameVisualObject) return;
    const safeZoom = Math.max(zoomLevel || 1, 0.1);
    frameVisualObject.set({
        strokeWidth: FRAME_STROKE_WIDTH / safeZoom,
        strokeDashArray: FRAME_DASH_PATTERN.map((segment) => segment / safeZoom)
    });
};

const pickObjectProps = (object, propertyNames) => (
    propertyNames.reduce((accumulator, propertyName) => {
        const value = object[propertyName];
        accumulator[propertyName] = Array.isArray(value) ? [...value] : value;
        return accumulator;
    }, {})
);

const Editor = forwardRef(({ brushMode, brushColor, brushSize }, ref) => {
    const canvasRef = useRef(null);
    const wrapperRef = useRef(null);
    const [fabricCanvas, setFabricCanvas] = useState(null);
    const [genFrame, setGenFrame] = useState(null);
    const [candidate, setCandidate] = useState(null);
    const [candidateUrl, setCandidateUrl] = useState(null);
    const [hasMaskOverlay, setHasMaskOverlay] = useState(false);
    const [isMaskOverlayVisible, setIsMaskOverlayVisible] = useState(false);
    const [genDimensions, setGenDimensions] = useState({
        width: CANVAS_DEFAULTS.DEFAULT_WIDTH,
        height: CANVAS_DEFAULTS.DEFAULT_HEIGHT
    });
    const [isMutatingCanvas, setIsMutatingCanvas] = useState(false);

    const brushModeRef = useRef(brushMode);
    const brushColorRef = useRef(brushColor);
    const brushSizeRef = useRef(brushSize);
    const candidateRef = useRef(null);
    const maskOverlayVisibleRef = useRef(false);
    const genFrameVisualRef = useRef(null);
    const mutationQueueRef = useRef(Promise.resolve());
    const transformStartRef = useRef(null);
    const undoAssetRegistryRef = useRef(new Map());

    const undoStackRef = useRef([]);
    const pushUndoSnapshot = (snapshot) => {
        if (!snapshot) return;
        undoStackRef.current.push(snapshot);
        if (undoStackRef.current.length > MAX_UNDO_STEPS) {
            undoStackRef.current.splice(0, undoStackRef.current.length - MAX_UNDO_STEPS);
        }
    };

    const setCandidateState = (nextCandidate, nextUrl = null) => {
        candidateRef.current = nextCandidate;
        setCandidate(nextCandidate);
        setCandidateUrl(nextUrl);
    };

    const syncCandidateFromCanvas = (canvas, frameObject = genFrame) => {
        const nextCandidate = canvas?.getObjects().find((object) => isCandidateObject(object, frameObject)) || null;
        setCandidateState(nextCandidate, nextCandidate?.candidateSourceUrl || null);
        return nextCandidate;
    };

    const getMaskGroupFromCanvas = (canvas) => (
        canvas?.getObjects().find((object) => object.id === 'maskGroup') || null
    );

    const syncMaskStateFromCanvas = (canvas = fabricCanvas) => {
        const maskGroup = getMaskGroupFromCanvas(canvas);
        const nextHasMask = !!(maskGroup && maskGroup.getObjects().length > 0);
        const nextMaskVisible = nextHasMask ? maskGroup.visible !== false : false;

        maskOverlayVisibleRef.current = nextMaskVisible;
        setHasMaskOverlay(nextHasMask);
        setIsMaskOverlayVisible(nextMaskVisible);
        return maskGroup;
    };

    const setMaskOverlayVisibility = (visible, canvas = fabricCanvas) => {
        const maskGroup = getMaskGroupFromCanvas(canvas);
        if (!maskGroup) {
            maskOverlayVisibleRef.current = false;
            setHasMaskOverlay(false);
            setIsMaskOverlayVisible(false);
            return null;
        }

        maskGroup.set({ visible });
        canvas?.requestRenderAll();
        syncMaskStateFromCanvas(canvas);
        return maskGroup;
    };

    const syncFrameVisualState = (frameObject = genFrame, frameVisualObject = genFrameVisualRef.current) => {
        if (!frameObject || !frameVisualObject) return;

        frameVisualObject.set({
            left: frameObject.left,
            top: frameObject.top,
            width: frameObject.width,
            height: frameObject.height,
            scaleX: frameObject.scaleX,
            scaleY: frameObject.scaleY,
            angle: frameObject.angle,
            visible: frameObject.visible
        });
        frameVisualObject.setCoords();
    };

    const registerUndoAsset = (object) => {
        if (!object || object.type !== 'image') {
            return null;
        }

        const element = object.getElement?.();
        if (!element) {
            return null;
        }

        const assetId = object.assetId || createClientId('undo-asset');
        if (!object.assetId) {
            object.set({ assetId });
        }
        if (!undoAssetRegistryRef.current.has(assetId)) {
            undoAssetRegistryRef.current.set(assetId, element);
        }
        return assetId;
    };

    const serializeUndoObject = (object) => {
        if (object.type === 'image') {
            const assetId = registerUndoAsset(object);
            if (!assetId) {
                return {
                    kind: 'object',
                    object: object.toObject(UNDO_SERIALIZED_PROPS)
                };
            }
            return {
                kind: 'image',
                assetId,
                props: pickObjectProps(object, UNDO_IMAGE_PROPS)
            };
        }

        return {
            kind: 'object',
            object: object.toObject(UNDO_SERIALIZED_PROPS)
        };
    };

    const pruneUndoAssets = (canvas = fabricCanvas) => {
        const referencedAssetIds = new Set();

        undoStackRef.current.forEach((snapshot) => {
            (snapshot?.objects || []).forEach((entry) => {
                if (entry?.kind === 'image' && entry.assetId) {
                    referencedAssetIds.add(entry.assetId);
                }
            });
        });

        canvas?.getObjects().forEach((object) => {
            const assetId = registerUndoAsset(object);
            if (assetId) {
                referencedAssetIds.add(assetId);
            }
        });

        for (const assetId of undoAssetRegistryRef.current.keys()) {
            if (!referencedAssetIds.has(assetId)) {
                undoAssetRegistryRef.current.delete(assetId);
            }
        }
    };

    const createUndoSnapshot = (canvas = fabricCanvas, frameObject = genFrame, frameVisualObject = genFrameVisualRef.current) => {
        if (!canvas || !frameObject || !frameVisualObject) {
            return null;
        }

        return {
            frame: serializeFrameState(frameObject),
            frameVisual: serializeFrameVisualState(frameVisualObject),
            objects: canvas
                .getObjects()
                .filter((object) => object !== frameObject && object !== frameVisualObject)
                .map(serializeUndoObject)
        };
    };

    const commitUndoSnapshot = (canvas = fabricCanvas, frameObject = genFrame, frameVisualObject = genFrameVisualRef.current) => {
        pushUndoSnapshot(createUndoSnapshot(canvas, frameObject, frameVisualObject));
        pruneUndoAssets(canvas);
    };

    const restoreUndoSnapshot = async (
        snapshot,
        canvas = fabricCanvas,
        frameObject = genFrame,
        frameVisualObject = genFrameVisualRef.current
    ) => {
        if (!snapshot || !canvas || !frameObject || !frameVisualObject) {
            return;
        }

        const enlivenedObjects = (await Promise.all((snapshot.objects || []).map(async (entry) => {
            if (entry?.kind === 'image') {
                const source = undoAssetRegistryRef.current.get(entry.assetId);
                if (!source) {
                    console.warn(`Missing undo asset: ${entry.assetId}`);
                    return null;
                }
                const image = new fabric.Image(source, entry.props || {});
                image.setCoords();
                return image;
            }

            return await new Promise((resolve) => {
                fabric.util.enlivenObjects([entry?.object], (objects) => {
                    resolve(objects[0] || null);
                });
            });
        }))).filter(Boolean);

        canvas.discardActiveObject();
        canvas.getObjects()
            .filter((object) => object !== frameObject && object !== frameVisualObject)
            .forEach((object) => canvas.remove(object));

        frameObject.set(snapshot.frame);
        frameObject.setCoords();
        frameVisualObject.set(snapshot.frameVisual);
        frameVisualObject.setCoords();
        genFrameVisualRef.current = frameVisualObject;

        enlivenedObjects.forEach((object) => {
            canvas.add(object);
        });

        syncFrameVisualState(frameObject, frameVisualObject);
        applyFrameViewportStyle(frameVisualObject, canvas.getZoom());
        setGenFrame(frameObject);
        setGenDimensions({
            width: Math.round(frameObject.width * frameObject.scaleX),
            height: Math.round(frameObject.height * frameObject.scaleY)
        });
        enforceCanvasLayerOrder(canvas, frameObject);
        syncCandidateFromCanvas(canvas, frameObject);
        syncMaskStateFromCanvas(canvas);
        syncCanvasInteractionMode(canvas, frameObject);
        pruneUndoAssets(canvas);
        canvas.requestRenderAll();
    };

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
        pushUndoSnapshot(createUndoSnapshot(canvas, frame, frameVisual));

        canvas.on('mouse:wheel', (opt) => {
            const delta = opt.e.deltaY;
            let zoom = canvas.getZoom();
            zoom *= 0.999 ** delta;
            if (zoom > 20) zoom = 20;
            if (zoom < 0.1) zoom = 0.1;
            canvas.zoomToPoint({ x: opt.e.offsetX, y: opt.e.offsetY }, zoom);
            updateFrameViewportStyle(zoom);
            frame.setCoords();
            frameVisual.setCoords();
            canvas.requestRenderAll();
            opt.e.preventDefault();
            opt.e.stopPropagation();
        });

        const gridSize = CANVAS_DEFAULTS.GRID_SIZE;
        const SNAP_DEADZONE = 2;
        const isTransformableObject = (target) => (
            !!target && (target === frame || isCandidateObject(target, frame) || isBaseRasterObject(target, frame))
        );
        const normalizeTransformAction = (action) => {
            if (action === 'drag') {
                return 'moving';
            }
            if (typeof action === 'string' && action.startsWith('scale')) {
                return 'scaling';
            }
            return null;
        };
        const snapPositionToGrid = (value) => Math.round(value / gridSize) * gridSize;
        const getDisplayBoundsFromTransform = (transform) => {
            const left = transform?.left ?? 0;
            const top = transform?.top ?? 0;
            const width = Math.max(1, Math.round((transform?.width ?? 0) * (transform?.scaleX ?? 1)));
            const height = Math.max(1, Math.round((transform?.height ?? 0) * (transform?.scaleY ?? 1)));

            return {
                left,
                top,
                width,
                height,
                right: left + width,
                bottom: top + height
            };
        };
        const getDisplayBoundsFromObject = (target) => getDisplayBoundsFromTransform({
            left: target.left,
            top: target.top,
            width: target.width,
            height: target.height,
            scaleX: target.scaleX,
            scaleY: target.scaleY
        });
        const snapEdgeByDirection = (rawEdge, baseEdge) => {
            const delta = rawEdge - baseEdge;
            if (Math.abs(delta) <= SNAP_DEADZONE) {
                return baseEdge;
            }
            return delta > 0
                ? Math.ceil(rawEdge / gridSize) * gridSize
                : Math.floor(rawEdge / gridSize) * gridSize;
        };
        const getSnappedResizeBounds = (baseBounds, currentBounds, corner = '') => {
            const nextBounds = {
                left: baseBounds.left,
                top: baseBounds.top,
                right: baseBounds.right,
                bottom: baseBounds.bottom
            };

            if (corner.includes('l')) {
                nextBounds.left = Math.min(
                    baseBounds.right - gridSize,
                    snapEdgeByDirection(currentBounds.left, baseBounds.left)
                );
            } else if (corner.includes('r')) {
                nextBounds.right = Math.max(
                    baseBounds.left + gridSize,
                    snapEdgeByDirection(currentBounds.right, baseBounds.right)
                );
            }

            if (corner.includes('t')) {
                nextBounds.top = Math.min(
                    baseBounds.bottom - gridSize,
                    snapEdgeByDirection(currentBounds.top, baseBounds.top)
                );
            } else if (corner.includes('b')) {
                nextBounds.bottom = Math.max(
                    baseBounds.top + gridSize,
                    snapEdgeByDirection(currentBounds.bottom, baseBounds.bottom)
                );
            }

            return {
                left: nextBounds.left,
                top: nextBounds.top,
                width: Math.max(gridSize, nextBounds.right - nextBounds.left),
                height: Math.max(gridSize, nextBounds.bottom - nextBounds.top)
            };
        };
        const applyDisplayBoundsToObject = (target, bounds) => {
            const sourceWidth = Math.max(1, target.width ?? 1);
            const sourceHeight = Math.max(1, target.height ?? 1);

            target.set({
                left: bounds.left,
                top: bounds.top,
                scaleX: bounds.width / sourceWidth,
                scaleY: bounds.height / sourceHeight
            });
            target.setCoords();
            return bounds;
        };
        const commitDisplayBoundsToObject = (target, bounds) => {
            if (target.type === 'image') {
                return applyDisplayBoundsToObject(target, bounds);
            }
            target.set({
                left: bounds.left,
                top: bounds.top,
                width: bounds.width,
                height: bounds.height,
                scaleX: 1,
                scaleY: 1
            });
            target.setCoords();
            return bounds;
        };
        let isDragging = false;
        let lastPosX = 0;
        let lastPosY = 0;

        canvas.on('before:transform', (event) => {
            const target = event.transform?.target;
            const action = normalizeTransformAction(event.transform?.action);

            if (!isTransformableObject(target) || !action) {
                transformStartRef.current = null;
                return;
            }

            transformStartRef.current = {
                object: target,
                previous: snapshotObjectTransform(target),
                action,
                corner: event.transform?.corner || ''
            };
        });

        canvas.on('mouse:down', (opt) => {
            const evt = opt.e;

            if (evt.altKey === true || brushModeRef.current === 'hand' || canvas.isSpacePanning) {
                isDragging = true;
                canvas.selection = false;
                lastPosX = evt.clientX;
                lastPosY = evt.clientY;
                canvas.defaultCursor = 'grabbing';
                return;
            }
        });

        canvas.on('mouse:move', (opt) => {
            if (!isDragging) return;
            const evt = opt.e;
            const viewportTransform = canvas.viewportTransform;
            viewportTransform[4] += evt.clientX - lastPosX;
            viewportTransform[5] += evt.clientY - lastPosY;
            canvas.requestRenderAll();
            lastPosX = evt.clientX;
            lastPosY = evt.clientY;
        });

        canvas.on('mouse:up', () => {
            if (isDragging) {
                canvas.setViewportTransform(canvas.viewportTransform);
            }
            isDragging = false;
            transformStartRef.current = null;
            canvas.defaultCursor = brushModeRef.current === 'hand' ? 'grab' : 'default';
        });

        canvas.on('object:moving', (event) => {
            const target = event.target;
            if (!target) return;
            if (!isTransformableObject(target)) {
                return;
            }
            target.set({
                left: snapPositionToGrid(target.left),
                top: snapPositionToGrid(target.top)
            });
            target.setCoords();
            if (target === frame) {
                syncFrameVisualState(frame, frameVisual);
            }
        });

        canvas.on('object:scaling', (event) => {
            const target = event.target;
            if (!target) return;
            if (!isTransformableObject(target)) {
                return;
            }

            const baseBounds = getDisplayBoundsFromTransform(
                transformStartRef.current?.object === target
                    ? transformStartRef.current.previous
                    : snapshotObjectTransform(target)
            );
            const currentBounds = getDisplayBoundsFromObject(target);
            const corner = transformStartRef.current?.object === target
                ? transformStartRef.current.corner
                : (event.transform?.corner || '');
            const snappedBounds = applyDisplayBoundsToObject(
                target,
                getSnappedResizeBounds(baseBounds, currentBounds, corner)
            );

            if (target === frame) {
                syncFrameVisualState(target, frameVisual);
                setGenDimensions({ width: snappedBounds.width, height: snappedBounds.height });
            }
        });

        canvas.on('object:modified', (event) => {
            const target = event.target;
            const transformStart = transformStartRef.current;
            if (!target || !transformStart || transformStart.object !== target) {
                return;
            }

            if (transformStart.action === 'scaling') {
                const corner = transformStart.corner || event.transform?.corner || '';
                const baseBounds = getDisplayBoundsFromTransform(transformStart.previous);
                const currentBounds = getDisplayBoundsFromObject(target);
                const snappedBounds = getSnappedResizeBounds(baseBounds, {
                    left: currentBounds.left,
                    right: currentBounds.right,
                    top: currentBounds.top,
                    bottom: currentBounds.bottom
                }, corner);
                commitDisplayBoundsToObject(target, snappedBounds);
                if (target === frame) {
                    syncFrameVisualState(target, frameVisual);
                    setGenDimensions({ width: snappedBounds.width, height: snappedBounds.height });
                }
            } else if (transformStart.action === 'moving') {
                target.set({
                    left: snapPositionToGrid(target.left),
                    top: snapPositionToGrid(target.top)
                });
                target.setCoords();
                if (target === frame) {
                    syncFrameVisualState(frame, frameVisual);
                }
            }

            const nextTransform = snapshotObjectTransform(target);
            if (!areTransformsEqual(transformStart.previous, nextTransform)) {
                commitUndoSnapshot(canvas, frame, frameVisual);
            }
            if (target === frame) {
                syncFrameVisualState(frame, frameVisual);
            }
            transformStartRef.current = null;
        });

        const handleResize = () => {
            if (!wrapperRef.current) return;
            canvas.setWidth(wrapperRef.current.clientWidth);
            canvas.setHeight(wrapperRef.current.clientHeight);
            canvas.requestRenderAll();
        };

        window.addEventListener('resize', handleResize);
        return () => {
            window.removeEventListener('resize', handleResize);
            canvas.dispose();
        };
    }, []);

    const syncCanvasInteractionMode = (
        canvas = fabricCanvas,
        frameObject = genFrame,
        currentCandidate = candidateRef.current
    ) => {
        if (!canvas || !frameObject) return;

        const currentBrushMode = brushModeRef.current;
        const currentBrushColor = brushColorRef.current;
        const currentBrushSize = brushSizeRef.current;
        const isDrawing = !['none', 'hand'].includes(currentBrushMode);
        canvas.isDrawingMode = isDrawing;
        canvas.selection = currentBrushMode === 'none';
        canvas.defaultCursor = currentBrushMode === 'hand' ? 'grab' : 'default';

        if (currentBrushMode !== 'none' && canvas.getActiveObject()) {
            canvas.discardActiveObject();
        }

        if (isDrawing) {
            const brush = new fabric.PencilBrush(canvas);
            brush.width = currentBrushMode === 'eraser' ? currentBrushSize * 2 : currentBrushSize;
            brush.color = currentBrushMode === 'mask'
                ? 'rgba(255, 0, 0, 1.0)'
                : (currentBrushMode === 'eraser' ? 'rgba(0, 0, 0, 1.0)' : currentBrushColor);
            canvas.freeDrawingBrush = brush;
        }

        canvas.getObjects().forEach((object) => {
            const isFrame = object === frameObject;
            const isBaseRaster = isBaseRasterObject(object, frameObject);
            const isCurrentCandidate = object === currentCandidate || isCandidateObject(object, frameObject);
            const interactive = currentBrushMode === 'none' && (isFrame || isCurrentCandidate || isBaseRaster);

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

    useEffect(() => {
        syncCanvasInteractionMode();
    }, [brushMode, brushColor, brushSize, fabricCanvas, genFrame, candidate]);

    useEffect(() => {
        if (!fabricCanvas || !genFrame) return;

        const handlePathCreated = (event) => {
            const path = event.path;
            const currentMode = brushModeRef.current;
            if (!path) return;

            if (currentMode === 'mask') {
                path.set({
                    editorRole: CANVAS_OBJECT_ROLES.MASK,
                    isMask: true,
                    selectable: false,
                    evented: false,
                    opacity: 1.0
                });

                let maskGroup = fabricCanvas.getObjects().find((object) => object.id === 'maskGroup');
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

                maskGroup.addWithUpdate(path);
                fabricCanvas.remove(path);
                if (candidateRef.current && !maskOverlayVisibleRef.current) {
                    maskGroup.set({ visible: false });
                }
                enforceCanvasLayerOrder(fabricCanvas, genFrame);
                syncMaskStateFromCanvas(fabricCanvas);
                fabricCanvas.requestRenderAll();
                commitUndoSnapshot(fabricCanvas, genFrame);
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
                    const result = await applyEraserPathToCanvas(fabricCanvas, path, genFrame);
                    if (result.removedObjects.length > 0 || result.addedObjects.length > 0) {
                        commitUndoSnapshot(fabricCanvas, genFrame);
                    }
                    syncCandidateFromCanvas(fabricCanvas);
                    syncCanvasInteractionMode();
                });
                return;
            }

            path.set({
                editorRole: CANVAS_OBJECT_ROLES.SKETCH,
                isMask: false,
                selectable: false,
                evented: false
            });
            enforceCanvasLayerOrder(fabricCanvas, genFrame);
            fabricCanvas.requestRenderAll();
            commitUndoSnapshot(fabricCanvas, genFrame);
        };

        fabricCanvas.on('path:created', handlePathCreated);
        return () => {
            fabricCanvas.off('path:created', handlePathCreated);
        };
    }, [fabricCanvas, genFrame]);

    const discardCandidateHelper = () => {
        if (!fabricCanvas || !candidateRef.current) return;
        fabricCanvas.remove(candidateRef.current);
        fabricCanvas.discardActiveObject();
        setCandidateState(null, null);
        setMaskOverlayVisibility(true, fabricCanvas);
        syncCanvasInteractionMode();
        commitUndoSnapshot(fabricCanvas, genFrame);
    };

    const performAccept = async () => {
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
            commitUndoSnapshot(fabricCanvas, genFrame);
        });
    };

    const performUndo = async () => {
        if (!fabricCanvas || !genFrame) return;

        await enqueueCanvasMutation(async () => {
            if (undoStackRef.current.length <= 1) {
                return;
            }

            undoStackRef.current.pop();
            const snapshot = undoStackRef.current[undoStackRef.current.length - 1];
            await restoreUndoSnapshot(snapshot, fabricCanvas, genFrame, genFrameVisualRef.current);
        });
    };

    const performDeleteActiveObject = () => {
        if (!fabricCanvas || !genFrame) return;

        const activeObject = fabricCanvas.getActiveObject();
        if (!activeObject || activeObject === genFrame) return;

        fabricCanvas.remove(activeObject);
        fabricCanvas.discardActiveObject();
        syncCandidateFromCanvas(fabricCanvas);
        syncCanvasInteractionMode();
        commitUndoSnapshot(fabricCanvas, genFrame);
    };

    useImperativeHandle(ref, () => ({
        setGenFrameSize: (width, height) => {
            if (!genFrame || !fabricCanvas) return;
            genFrame.set({ width, height, scaleX: 1, scaleY: 1 });
            genFrame.setCoords();
            syncFrameVisualState(genFrame);
            setGenDimensions({ width, height });
            enforceCanvasLayerOrder(fabricCanvas, genFrame);
            syncCanvasInteractionMode();
            commitUndoSnapshot(fabricCanvas, genFrame);
        },

        addGeneratedImage: async (url) => {
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
                        maskGroup.set({ visible: false });
                    }
                    enforceCanvasLayerOrder(fabricCanvas, genFrame);
                    setCandidateState(image, url);
                    syncMaskStateFromCanvas(fabricCanvas);
                    syncCanvasInteractionMode();
                    commitUndoSnapshot(fabricCanvas, genFrame);
                    resolve();
                }, { crossOrigin: 'anonymous' });
            });
        },

        acceptCandidate: () => {
            void performAccept();
        },

        discardCandidate: () => {
            discardCandidateHelper();
        },

        exportForGeneration: async () => exportCanvasState(fabricCanvas, genFrame),

        undo: performUndo,

        clearAll: () => {
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
            commitUndoSnapshot(fabricCanvas, genFrame);
        }
    }));

    const performUndoRef = useRef(performUndo);
    useEffect(() => {
        performUndoRef.current = performUndo;
    });

    const toggleMaskOverlayPreview = () => {
        if (!fabricCanvas || !hasMaskOverlay) return;
        setMaskOverlayVisibility(!isMaskOverlayVisible, fabricCanvas);
    };

    useEffect(() => {
        if (!fabricCanvas || !genFrame) return;

        const handleKeyDown = (event) => {
            if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') return;

            if ((event.ctrlKey || event.metaKey) && event.code === 'KeyZ') {
                event.preventDefault();
                void performUndoRef.current();
                return;
            }

            if (event.code === 'Space' && !event.repeat && brushModeRef.current !== 'hand') {
                event.preventDefault();
                fabricCanvas.isSpacePanning = true;
                fabricCanvas.defaultCursor = 'grab';
                fabricCanvas.isDrawingMode = false;
                fabricCanvas.selection = false;
                fabricCanvas.forEachObject((object) => {
                    object.evented = false;
                });
                return;
            }

            if (event.key === 'Delete' || event.key === 'Backspace') {
                performDeleteActiveObject();
            }
        };

        const handleKeyUp = (event) => {
            if (event.code !== 'Space' || !fabricCanvas.isSpacePanning) return;
            fabricCanvas.isSpacePanning = false;
            syncCanvasInteractionMode();
        };

        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('keyup', handleKeyUp);
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('keyup', handleKeyUp);
        };
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
