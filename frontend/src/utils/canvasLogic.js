import { fabric } from 'fabric';
import { CANVAS_DEFAULTS, CANVAS_OBJECT_ROLES } from '../constants';

// Чисто экранные оверлеи: никогда не экспортируются и сортируются как FRAME.
export const UI_OVERLAY_ROLES = [
    'quick-select-overlay',
    'selection-overlay',
    'crop-overlay'
];

const LAYER_PRIORITY = {
    [CANVAS_OBJECT_ROLES.FRAME_HIT_AREA]: -1,
    [CANVAS_OBJECT_ROLES.BASE]: 0,
    [CANVAS_OBJECT_ROLES.CANDIDATE]: 1,
    [CANVAS_OBJECT_ROLES.SKETCH]: 2,
    [CANVAS_OBJECT_ROLES.MASK]: 3,
    [CANVAS_OBJECT_ROLES.FRAME]: 4
};

const cloneFabricObject = (object) => (
    new Promise((resolve, reject) => {
        object.clone((cloned) => {
            if (!cloned) {
                reject(new Error('Failed to clone Fabric object.'));
                return;
            }
            resolve(cloned);
        });
    })
);

const rectsIntersect = (a, b) => (
    a.left < (b.left + b.width)
    && (a.left + a.width) > b.left
    && a.top < (b.top + b.height)
    && (a.top + a.height) > b.top
);

const getRole = (object, genFrame) => {
    if (!object) return CANVAS_OBJECT_ROLES.BASE;
    if (genFrame && object === genFrame) return object.editorRole || CANVAS_OBJECT_ROLES.FRAME;
    if (object.id === 'maskGroup' || object.isMask || object.editorRole === CANVAS_OBJECT_ROLES.MASK) {
        return CANVAS_OBJECT_ROLES.MASK;
    }
    if (object.editorRole === CANVAS_OBJECT_ROLES.FRAME_HIT_AREA) {
        return CANVAS_OBJECT_ROLES.FRAME_HIT_AREA;
    }
    if (UI_OVERLAY_ROLES.includes(object.editorRole)) {
        return CANVAS_OBJECT_ROLES.FRAME;
    }
    if (object.isCandidate || object.editorRole === CANVAS_OBJECT_ROLES.CANDIDATE) {
        return CANVAS_OBJECT_ROLES.CANDIDATE;
    }
    if (object.editorRole === CANVAS_OBJECT_ROLES.SKETCH) {
        return CANVAS_OBJECT_ROLES.SKETCH;
    }
    if (object.editorRole === CANVAS_OBJECT_ROLES.FRAME) {
        return CANVAS_OBJECT_ROLES.FRAME;
    }
    return CANVAS_OBJECT_ROLES.BASE;
};

const isUiOnlyObject = (object) => (
    object?.excludeFromExport === true
    || UI_OVERLAY_ROLES.includes(object?.editorRole)
);

const getObjectBounds = (object) => {
    const rect = object.getBoundingRect(true, true);
    return {
        left: Math.floor(rect.left),
        top: Math.floor(rect.top),
        width: Math.max(1, Math.ceil(rect.width)),
        height: Math.max(1, Math.ceil(rect.height))
    };
};

const getRasterObjectRenderBounds = (object) => ({
    left: object.left ?? 0,
    top: object.top ?? 0,
    width: Math.max(1, Math.round((object.width ?? 0) * (object.scaleX ?? 1))),
    height: Math.max(1, Math.round((object.height ?? 0) * (object.scaleY ?? 1)))
});

const mergeRectBounds = (rects) => {
    if (!rects || rects.length === 0) {
        return null;
    }

    const left = Math.min(...rects.map((rect) => rect.left));
    const top = Math.min(...rects.map((rect) => rect.top));
    const right = Math.max(...rects.map((rect) => rect.left + rect.width));
    const bottom = Math.max(...rects.map((rect) => rect.top + rect.height));

    return {
        left,
        top,
        width: Math.max(1, Math.ceil(right - left)),
        height: Math.max(1, Math.ceil(bottom - top))
    };
};

const alignBoundsToGrid = (bounds) => {
    if (!bounds) {
        return null;
    }

    const snappedLeft = Math.floor(bounds.left / CANVAS_DEFAULTS.GRID_SIZE) * CANVAS_DEFAULTS.GRID_SIZE;
    const snappedTop = Math.floor(bounds.top / CANVAS_DEFAULTS.GRID_SIZE) * CANVAS_DEFAULTS.GRID_SIZE;
    const right = bounds.left + bounds.width;
    const bottom = bounds.top + bounds.height;

    return {
        left: snappedLeft,
        top: snappedTop,
        width: Math.max(1, Math.ceil(right - snappedLeft)),
        height: Math.max(1, Math.ceil(bottom - snappedTop))
    };
};

const canvasHasVisiblePixels = (canvasEl) => {
    const ctx = canvasEl.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
        return false;
    }

    const { data } = ctx.getImageData(0, 0, canvasEl.width, canvasEl.height);
    for (let index = 3; index < data.length; index += 4) {
        if (data[index] !== 0) {
            return true;
        }
    }
    return false;
};

const renderObjectIntoCanvas = (ctx, object, bounds, temporaryProps = null) => {
    const originalCanvas = object.canvas;
    const originalDirty = object.dirty;
    const originalProps = temporaryProps
        ? Object.fromEntries(Object.keys(temporaryProps).map((key) => [key, object[key]]))
        : null;

    try {
        if (temporaryProps) {
            object.set(temporaryProps);
        }
        object.canvas = null;
        ctx.save();
        ctx.translate(-bounds.left, -bounds.top);
        object.render(ctx);
        ctx.restore();
    } finally {
        if (temporaryProps && originalProps) {
            object.set(originalProps);
        }
        object.canvas = originalCanvas;
        object.dirty = originalDirty;
    }
};

const rasterizeObjects = (entries, bounds) => {
    const canvasEl = fabric.util.createCanvasElement();
    canvasEl.width = bounds.width;
    canvasEl.height = bounds.height;
    const ctx = canvasEl.getContext('2d');
    if (!ctx) {
        return null;
    }

    entries.forEach(({ object, temporaryProps }) => {
        renderObjectIntoCanvas(ctx, object, bounds, temporaryProps);
    });

    if (!canvasHasVisiblePixels(canvasEl)) {
        return null;
    }

    return canvasEl;
};

const renderEntriesToCanvas = (entries, bounds, backgroundColor = null) => {
    const canvasEl = fabric.util.createCanvasElement();
    canvasEl.width = bounds.width;
    canvasEl.height = bounds.height;
    const ctx = canvasEl.getContext('2d');
    if (!ctx) {
        throw new Error('Failed to create export canvas context.');
    }

    if (backgroundColor) {
        ctx.fillStyle = backgroundColor;
        ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);
    }

    entries.forEach(({ object, temporaryProps }) => {
        renderObjectIntoCanvas(ctx, object, bounds, temporaryProps);
    });

    return canvasEl;
};

const canvasElementToBlob = (canvasEl, type, quality) => (
    new Promise((resolve, reject) => {
        canvasEl.toBlob((blob) => {
            if (!blob) {
                reject(new Error('Failed to build export blob.'));
                return;
            }
            resolve(blob);
        }, type, quality);
    })
);

const getDocumentSnapshotBounds = (objects, frame) => {
    const renderBounds = objects.map((object) => {
        const role = getRole(object, frame);
        if (
            role === CANVAS_OBJECT_ROLES.BASE
            || role === CANVAS_OBJECT_ROLES.CANDIDATE
        ) {
            return getRasterObjectRenderBounds(object);
        }
        return getObjectBounds(object);
    });

    const mergedBounds = mergeRectBounds(renderBounds);
    if (mergedBounds) {
        return mergedBounds;
    }

    return {
        left: frame.left,
        top: frame.top,
        width: Math.round(frame.width * frame.scaleX),
        height: Math.round(frame.height * frame.scaleY)
    };
};

const createRasterObject = (source, bounds, role) => {
    const image = new fabric.Image(source, {
        left: bounds.left,
        top: bounds.top,
        originX: 'left',
        originY: 'top',
        scaleX: 1,
        scaleY: 1,
        objectCaching: false,
        noScaleCache: false,
        selectable: false,
        evented: false,
        hasControls: false,
        lockMovementX: true,
        lockMovementY: true,
        lockRotation: true,
        lockScalingX: true,
        lockScalingY: true,
        hoverCursor: 'default',
        editorRole: role
    });

    image.setCoords();
    return image;
};

export const isBaseRasterObject = (object, genFrame) => (
    getRole(object, genFrame) === CANVAS_OBJECT_ROLES.BASE
);

export const isCandidateObject = (object, genFrame) => (
    getRole(object, genFrame) === CANVAS_OBJECT_ROLES.CANDIDATE
);

export const isMaskObject = (object, genFrame) => (
    getRole(object, genFrame) === CANVAS_OBJECT_ROLES.MASK
);

export const isSketchObject = (object, genFrame) => (
    getRole(object, genFrame) === CANVAS_OBJECT_ROLES.SKETCH
);

export const getBaseRasterObjects = (canvas, genFrame) => (
    canvas.getObjects().filter((object) => isBaseRasterObject(object, genFrame))
);

export const enforceCanvasLayerOrder = (canvas, genFrame) => {
    if (!canvas) return;

    const orderedObjects = canvas.getObjects().slice().sort((left, right) => {
        const leftRole = getRole(left, genFrame);
        const rightRole = getRole(right, genFrame);
        return (LAYER_PRIORITY[leftRole] ?? 0) - (LAYER_PRIORITY[rightRole] ?? 0);
    });

    orderedObjects.forEach((object, index) => {
        object.moveTo(index);
    });
};

export const bakeCandidateIntoCanvas = async (canvas, candidate, genFrame) => {
    if (!canvas || !candidate) {
        return { addedObjects: [], removedObjects: [] };
    }

    const candidateBounds = getRasterObjectRenderBounds(candidate);
    const affectedBaseObjects = getBaseRasterObjects(canvas, genFrame).filter((object) => (
        rectsIntersect(getRasterObjectRenderBounds(object), candidateBounds)
    ));
    const removedObjects = [...affectedBaseObjects, candidate];
    const bounds = alignBoundsToGrid(mergeRectBounds([
        candidateBounds,
        ...affectedBaseObjects.map((object) => getRasterObjectRenderBounds(object))
    ]));
    const rasterCanvas = rasterizeObjects([
        ...affectedBaseObjects.map((object) => ({ object })),
        {
            object: candidate,
            temporaryProps: {
                stroke: null,
                strokeWidth: 0
            }
        }
    ], bounds);

    removedObjects.forEach((object) => canvas.remove(object));

    const addedObjects = [];
    if (rasterCanvas) {
        const bakedObject = createRasterObject(rasterCanvas, bounds, CANVAS_OBJECT_ROLES.BASE);
        canvas.add(bakedObject);
        addedObjects.push(bakedObject);
    }

    enforceCanvasLayerOrder(canvas, genFrame);
    canvas.requestRenderAll();

    return { addedObjects, removedObjects };
};

export const applyEraserPathToCanvas = async (canvas, eraserPath, genFrame) => {
    if (!canvas || !eraserPath) {
        return { addedObjects: [], removedObjects: [] };
    }

    const eraserBounds = getObjectBounds(eraserPath);
    const affectedBaseObjects = getBaseRasterObjects(canvas, genFrame).filter((object) => (
        rectsIntersect(getObjectBounds(object), eraserBounds)
    ));

    if (affectedBaseObjects.length === 0) {
        canvas.remove(eraserPath);
        canvas.requestRenderAll();
        return { addedObjects: [], removedObjects: [] };
    }

    canvas.remove(eraserPath);
    const addedObjects = [];

    for (const object of affectedBaseObjects) {
        const bounds = getRasterObjectRenderBounds(object);
        const rasterCanvas = rasterizeObjects([
            { object },
            { object: eraserPath }
        ], bounds);

        canvas.remove(object);

        if (!rasterCanvas) {
            continue;
        }

        const bakedObject = createRasterObject(rasterCanvas, bounds, CANVAS_OBJECT_ROLES.BASE);
        canvas.add(bakedObject);
        addedObjects.push(bakedObject);
    }

    enforceCanvasLayerOrder(canvas, genFrame);
    canvas.requestRenderAll();

    return { addedObjects, removedObjects: affectedBaseObjects };
};

/**
 * Exports the content within the frame for generation
 * @param {fabric.Canvas} canvas
 * @param {fabric.Object} frame
 * @returns {Promise<{image: Blob, mask: Blob|null, width: number, height: number}>}
 */
export const exportCanvasState = async (canvas, frame) => {
    if (!canvas || !frame) throw new Error('Canvas invalid');

    const bounds = {
        left: frame.left,
        top: frame.top,
        width: Math.round(frame.width * frame.scaleX),
        height: Math.round(frame.height * frame.scaleY)
    };

    const objects = canvas.getObjects();
    const maskGroup = objects.find((object) => object.id === 'maskGroup');
    const hasExplicitMasks = !!(maskGroup && maskGroup.getObjects().length > 0);
    const sketchObjects = objects.filter((object) => (
        object.visible !== false && isSketchObject(object, frame)
    ));
    const hasSketches = sketchObjects.length > 0;
    const useOpaqueBackground = !hasExplicitMasks && hasSketches;

    const initObjects = objects.filter((object) => (
        object.visible !== false
        && object !== frame
        && object.editorRole !== CANVAS_OBJECT_ROLES.FRAME_HIT_AREA
        && object.editorRole !== CANVAS_OBJECT_ROLES.FRAME
        && !isUiOnlyObject(object)
        && !isMaskObject(object, frame)
        && !isCandidateObject(object, frame)
    ));
    const initCanvas = renderEntriesToCanvas(
        initObjects.map((object) => ({ object })),
        bounds,
        useOpaqueBackground ? '#808080' : null
    );
    const initBlob = await canvasElementToBlob(
        initCanvas,
        useOpaqueBackground ? 'image/jpeg' : 'image/png',
        0.95
    );

    let maskBlob = null;
    if (hasExplicitMasks) {
        const maskClone = await cloneFabricObject(maskGroup);
        maskClone.set({
            visible: true,
            opacity: 1.0
        });
        maskClone.getObjects().forEach((child) => {
            child.set({
                visible: true,
                opacity: 1.0,
                stroke: 'white',
                // Залитые маски (например, из выделения) тоже должны стать белыми.
                ...(child.fill ? { fill: 'white' } : {})
            });
        });
        const maskCanvas = renderEntriesToCanvas([{ object: maskClone }], bounds, 'black');
        maskBlob = await canvasElementToBlob(maskCanvas, 'image/png');
    } else if (hasSketches) {
        const sketchClones = await Promise.all(sketchObjects.map(async (object) => {
            const clone = await cloneFabricObject(object);
            clone.set({
                visible: true,
                fill: 'white',
                stroke: 'white',
                opacity: 1.0
            });
            return clone;
        }));
        const maskCanvas = renderEntriesToCanvas(
            sketchClones.map((object) => ({ object })),
            bounds,
            'black'
        );
        maskBlob = await canvasElementToBlob(maskCanvas, 'image/png');
    }

    return {
        image: initBlob,
        mask: maskBlob,
        width: bounds.width,
        height: bounds.height
    };
};

const placeImageOnCanvas = (fabricCanvas, img) => {
    const vt = fabricCanvas.viewportTransform;
    const zoom = vt[0];
    const viewCenterX = (-vt[4] + fabricCanvas.getWidth() / 2) / zoom;
    const viewCenterY = (-vt[5] + fabricCanvas.getHeight() / 2) / zoom;
    const maxW = (fabricCanvas.getWidth() * 0.8) / zoom;
    const maxH = (fabricCanvas.getHeight() * 0.8) / zoom;
    const scale = Math.min(1, maxW / img.width, maxH / img.height);
    img.set({
        left: viewCenterX - (img.width * scale) / 2,
        top: viewCenterY - (img.height * scale) / 2,
        scaleX: scale,
        scaleY: scale,
        originX: 'left',
        originY: 'top',
        objectCaching: false,
        noScaleCache: false,
        selectable: true,
        evented: true,
        hasControls: true,
        lockRotation: true,
        editorRole: CANVAS_OBJECT_ROLES.BASE,
        hoverCursor: 'move'
    });
    img.setCoords();
    fabricCanvas.add(img);
    fabricCanvas.setActiveObject(img);
    fabricCanvas.requestRenderAll();
};

export const importImageToCanvas = (fabricCanvas, file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => {
        fabric.Image.fromURL(event.target.result, (img) => {
            if (!img) {
                reject(new Error('Failed to load image'));
                return;
            }
            placeImageOnCanvas(fabricCanvas, img);
            resolve(img);
        });
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
});

export const importImageFromUrl = (fabricCanvas, url) => new Promise((resolve, reject) => {
    fabric.Image.fromURL(url, (img) => {
        if (!img || !img.width) {
            reject(new Error('Failed to load image from URL'));
            return;
        }
        placeImageOnCanvas(fabricCanvas, img);
        resolve(img);
    }, { crossOrigin: 'anonymous' });
});

export const exportCanvasAsFile = async (fabricCanvas, genFrame, { format = 'png', quality = 0.92, mode = 'content' } = {}) => {
    const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const backgroundColor = format === 'jpeg' ? '#ffffff' : null;

    const exportableObjects = fabricCanvas.getObjects().filter((object) => (
        object.visible !== false
        && object !== genFrame
        && object.editorRole !== CANVAS_OBJECT_ROLES.FRAME_HIT_AREA
        && object.editorRole !== CANVAS_OBJECT_ROLES.FRAME
        && !isUiOnlyObject(object)
        && !isMaskObject(object, genFrame)
        && !isSketchObject(object, genFrame)
    ));

    let bounds;
    if (mode === 'viewport') {
        const vt = fabricCanvas.viewportTransform;
        const zoom = vt[0];
        bounds = {
            left: Math.round(-vt[4] / zoom),
            top: Math.round(-vt[5] / zoom),
            width: Math.max(1, Math.round(fabricCanvas.getWidth() / zoom)),
            height: Math.max(1, Math.round(fabricCanvas.getHeight() / zoom))
        };
    } else {
        bounds = getDocumentSnapshotBounds(exportableObjects, genFrame);
    }

    const snapshotCanvas = renderEntriesToCanvas(
        exportableObjects.map((object) => ({
            object,
            temporaryProps: isCandidateObject(object, genFrame)
                ? { stroke: null, strokeWidth: 0 }
                : null
        })),
        bounds,
        backgroundColor
    );

    const blob = await canvasElementToBlob(snapshotCanvas, mimeType, quality);
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = `canvas-export.${format === 'jpeg' ? 'jpg' : 'png'}`;
    anchor.click();
    URL.revokeObjectURL(objectUrl);
};

export const exportDocumentSnapshot = async (canvas, frame) => {
    if (!canvas || !frame) {
        throw new Error('Canvas invalid');
    }

    const exportableObjects = canvas.getObjects().filter((object) => (
        object.visible !== false
        && object !== frame
        && object.editorRole !== CANVAS_OBJECT_ROLES.FRAME_HIT_AREA
        && object.editorRole !== CANVAS_OBJECT_ROLES.FRAME
        && !isUiOnlyObject(object)
        && !isMaskObject(object, frame)
        && !isSketchObject(object, frame)
    ));

    const bounds = getDocumentSnapshotBounds(exportableObjects, frame);
    const snapshotCanvas = renderEntriesToCanvas(
        exportableObjects.map((object) => ({
            object,
            temporaryProps: isCandidateObject(object, frame)
                ? {
                    stroke: null,
                    strokeWidth: 0
                }
                : null
        })),
        bounds,
        null
    );

    const image = await canvasElementToBlob(snapshotCanvas, 'image/png');
    return {
        image,
        width: bounds.width,
        height: bounds.height
    };
};
