import { areTransformsEqual, snapshotObjectTransform } from './helpers';
import { TOOL_MODES, isAltModifierToolMode, getCursorForToolMode } from './toolModes';

const SNAP_DEADZONE = 2;

const createTransformHelpers = (gridSize) => {
    const snapPositionToGrid = (value) => Math.round(value / gridSize) * gridSize;

    const normalizeTransformAction = (action) => {
        if (action === 'drag') {
            return 'moving';
        }
        if (typeof action === 'string' && action.startsWith('scale')) {
            return 'scaling';
        }
        if (action === 'rotate') {
            return 'rotating';
        }
        return null;
    };

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

    return {
        applyDisplayBoundsToObject,
        commitDisplayBoundsToObject,
        getDisplayBoundsFromObject,
        getDisplayBoundsFromTransform,
        getSnappedResizeBounds,
        normalizeTransformAction,
        snapPositionToGrid
    };
};

export const setupCanvasViewportAndTransform = ({
    canvas,
    wrapperElement,
    frame,
    frameVisual,
    brushModeRef,
    gridSize,
    updateFrameViewportStyle,
    syncFrameVisualState,
    setGenDimensions,
    markUndoDirty,
    commitUndoSnapshot,
    getUndoSnapshotParams,
    isCandidateObject,
    isBaseRasterObject
}) => {
    const {
        applyDisplayBoundsToObject,
        commitDisplayBoundsToObject,
        getDisplayBoundsFromObject,
        getDisplayBoundsFromTransform,
        getSnappedResizeBounds,
        normalizeTransformAction,
        snapPositionToGrid
    } = createTransformHelpers(gridSize);

    const isTransformableObject = (target) => (
        !!target && (target === frame || isCandidateObject(target, frame) || isBaseRasterObject(target, frame))
    );

    let transformStart = null;
    let isDragging = false;
    let lastPosX = 0;
    let lastPosY = 0;

    const handleMouseWheel = (opt) => {
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
    };

    const handleBeforeTransform = (event) => {
        const target = event.transform?.target;
        const action = normalizeTransformAction(event.transform?.action);

        if (!isTransformableObject(target) || !action) {
            transformStart = null;
            return;
        }

        transformStart = {
            object: target,
            previous: snapshotObjectTransform(target),
            action,
            corner: event.transform?.corner || ''
        };
    };

    const handleMouseDown = (opt) => {
        const evt = opt.e;

        const isToolAltModifier = isAltModifierToolMode(brushModeRef.current) && evt.altKey === true;
        if (!isToolAltModifier && (evt.altKey === true || brushModeRef.current === TOOL_MODES.HAND || canvas.isSpacePanning)) {
            isDragging = true;
            canvas.selection = false;
            lastPosX = evt.clientX;
            lastPosY = evt.clientY;
            canvas.defaultCursor = 'grabbing';
        }
    };

    const handleMouseMove = (opt) => {
        if (!isDragging) return;

        const evt = opt.e;
        const viewportTransform = canvas.viewportTransform;
        viewportTransform[4] += evt.clientX - lastPosX;
        viewportTransform[5] += evt.clientY - lastPosY;
        canvas.requestRenderAll();
        lastPosX = evt.clientX;
        lastPosY = evt.clientY;
    };

    const handleMouseUp = () => {
        if (isDragging) {
            canvas.setViewportTransform(canvas.viewportTransform);
        }
        isDragging = false;
        transformStart = null;
        canvas.defaultCursor = getCursorForToolMode(brushModeRef.current);
    };

    const handleObjectMoving = (event) => {
        const target = event.target;
        if (!target || !isTransformableObject(target)) {
            return;
        }
        // Снэппинг к сетке считает границы без учёта угла — повернутые
        // объекты двигаем свободно.
        if (target.angle) {
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
    };

    const handleObjectScaling = (event) => {
        const target = event.target;
        if (!target || !isTransformableObject(target)) {
            return;
        }
        if (target.angle) {
            return;
        }

        const baseBounds = getDisplayBoundsFromTransform(
            transformStart?.object === target
                ? transformStart.previous
                : snapshotObjectTransform(target)
        );
        const currentBounds = getDisplayBoundsFromObject(target);
        const corner = transformStart?.object === target
            ? transformStart.corner
            : (event.transform?.corner || '');
        const snappedBounds = applyDisplayBoundsToObject(
            target,
            getSnappedResizeBounds(baseBounds, currentBounds, corner)
        );

        if (target === frame) {
            syncFrameVisualState(target, frameVisual);
            setGenDimensions({ width: snappedBounds.width, height: snappedBounds.height });
        }
    };

    const handleObjectModified = (event) => {
        const target = event.target;
        if (!target || !transformStart || transformStart.object !== target) {
            return;
        }

        if (transformStart.action === 'scaling' && !target.angle) {
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
            markUndoDirty(target);
            if (target === frame) {
                markUndoDirty(frameVisual);
            }
            commitUndoSnapshot(getUndoSnapshotParams(canvas, frame, frameVisual));
        }
        if (target === frame) {
            syncFrameVisualState(frame, frameVisual);
        }
        transformStart = null;
    };

    const handleResize = () => {
        if (!wrapperElement) return;
        canvas.setWidth(wrapperElement.clientWidth);
        canvas.setHeight(wrapperElement.clientHeight);
        canvas.requestRenderAll();
    };

    canvas.on('mouse:wheel', handleMouseWheel);
    canvas.on('before:transform', handleBeforeTransform);
    canvas.on('mouse:down', handleMouseDown);
    canvas.on('mouse:move', handleMouseMove);
    canvas.on('mouse:up', handleMouseUp);
    canvas.on('object:moving', handleObjectMoving);
    canvas.on('object:scaling', handleObjectScaling);
    canvas.on('object:modified', handleObjectModified);
    window.addEventListener('resize', handleResize);

    return () => {
        window.removeEventListener('resize', handleResize);
        canvas.off('mouse:wheel', handleMouseWheel);
        canvas.off('before:transform', handleBeforeTransform);
        canvas.off('mouse:down', handleMouseDown);
        canvas.off('mouse:move', handleMouseMove);
        canvas.off('mouse:up', handleMouseUp);
        canvas.off('object:moving', handleObjectMoving);
        canvas.off('object:scaling', handleObjectScaling);
        canvas.off('object:modified', handleObjectModified);
    };
};
