import { fabric } from 'fabric';
import { CANVAS_DEFAULTS, CANVAS_OBJECT_ROLES } from '../constants';

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

const mergeBounds = (objects) => {
    if (!objects || objects.length === 0) {
        return null;
    }

    const rects = objects.map(getObjectBounds);
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

const rasterizeObjects = async (objects, bounds) => {
    const canvasEl = fabric.util.createCanvasElement();
    canvasEl.width = bounds.width;
    canvasEl.height = bounds.height;

    const staticCanvas = new fabric.StaticCanvas(canvasEl, {
        width: bounds.width,
        height: bounds.height,
        backgroundColor: null,
        renderOnAddRemove: false,
        enableRetinaScaling: false
    });

    try {
        for (const object of objects) {
            const cloned = await cloneFabricObject(object);
            cloned.set({
                left: (object.left ?? 0) - bounds.left,
                top: (object.top ?? 0) - bounds.top,
                selectable: false,
                evented: false
            });
            staticCanvas.add(cloned);
        }

        staticCanvas.renderAll();

        if (!canvasHasVisiblePixels(canvasEl)) {
            return null;
        }

        return canvasEl.toDataURL('image/png');
    } finally {
        staticCanvas.dispose();
    }
};

const createRasterObject = async (dataUrl, bounds, role) => (
    new Promise((resolve, reject) => {
        fabric.Image.fromURL(dataUrl, (image) => {
            if (!image) {
                reject(new Error('Failed to build raster image.'));
                return;
            }

            image.set({
                left: bounds.left,
                top: bounds.top,
                originX: 'left',
                originY: 'top',
                scaleX: 1,
                scaleY: 1,
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

            resolve(image);
        }, { crossOrigin: 'anonymous' });
    })
);

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

    const candidateBounds = getObjectBounds(candidate);
    const affectedBaseObjects = getBaseRasterObjects(canvas, genFrame).filter((object) => (
        rectsIntersect(getObjectBounds(object), candidateBounds)
    ));
    const removedObjects = [...affectedBaseObjects, candidate];
    const bounds = alignBoundsToGrid(mergeBounds(removedObjects));
    const rasterCandidate = await cloneFabricObject(candidate);
    rasterCandidate.set({
        stroke: null,
        strokeWidth: 0,
        isCandidate: false,
        editorRole: CANVAS_OBJECT_ROLES.BASE
    });
    const dataUrl = await rasterizeObjects([...affectedBaseObjects, rasterCandidate], bounds);

    removedObjects.forEach((object) => canvas.remove(object));

    const addedObjects = [];
    if (dataUrl) {
        const bakedObject = await createRasterObject(dataUrl, bounds, CANVAS_OBJECT_ROLES.BASE);
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
        const dataUrl = await rasterizeObjects([object, eraserPath], bounds);

        canvas.remove(object);

        if (!dataUrl) {
            continue;
        }

        const bakedObject = await createRasterObject(dataUrl, bounds, CANVAS_OBJECT_ROLES.BASE);
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

    const left = frame.left;
    const top = frame.top;
    const width = Math.round(frame.width * frame.scaleX);
    const height = Math.round(frame.height * frame.scaleY);

    const dataToBlob = async (dataURL) => {
        const res = await fetch(dataURL);
        return await res.blob();
    };

    const originalVpt = [...canvas.viewportTransform];
    const originalBg = canvas.backgroundColor;

    const objectStates = canvas.getObjects().map((object) => ({
        object,
        visible: object.visible,
        stroke: object.stroke,
        fill: object.fill,
        opacity: object.opacity
    }));

    let initDataURL = null;
    let maskDataURL = null;

    try {
        canvas.viewportTransform = [1, 0, 0, 1, 0, 0];

        const maskGroup = canvas.getObjects().find((object) => object.id === 'maskGroup');
        const hasExplicitMasks = !!(maskGroup && maskGroup.getObjects().length > 0);
        const hasSketches = objectStates.some(({ object }) => isSketchObject(object, frame));

        let useOpaqueBackground = false;
        if (hasExplicitMasks) {
            canvas.backgroundColor = null;
        } else if (hasSketches) {
            canvas.backgroundColor = '#808080';
            useOpaqueBackground = true;
        } else {
            canvas.backgroundColor = null;
        }

        canvas.getObjects().forEach((object) => {
            if (
                object === frame
                || object.editorRole === CANVAS_OBJECT_ROLES.FRAME_HIT_AREA
                || object.editorRole === CANVAS_OBJECT_ROLES.FRAME
                || isMaskObject(object, frame)
                || isCandidateObject(object, frame)
            ) {
                object.visible = false;
            }
        });

        initDataURL = canvas.toDataURL({
            format: useOpaqueBackground ? 'jpeg' : 'png',
            quality: 0.95,
            left,
            top,
            width,
            height,
            multiplier: 1
        });

        if (hasExplicitMasks) {
            canvas.backgroundColor = 'black';
            canvas.getObjects().forEach((object) => {
                if (object === frame) {
                    object.visible = false;
                    return;
                }

                if (object.id === 'maskGroup') {
                    object.visible = true;
                    object._originalOpacity = object.opacity;
                    object.opacity = 1.0;

                    object.getObjects().forEach((child) => {
                        child._originalOpacity = child.opacity;
                        child.opacity = 1.0;
                        if (child.stroke !== 'white') {
                            child._originalStroke = child.stroke;
                            child.stroke = 'white';
                        }
                    });
                } else {
                    object.visible = false;
                }
            });

            maskDataURL = canvas.toDataURL({
                format: 'png',
                left,
                top,
                width,
                height,
                multiplier: 1
            });

            canvas.getObjects().forEach((object) => {
                if (object.id === 'maskGroup') {
                    if (object._originalOpacity !== undefined) {
                        object.opacity = object._originalOpacity;
                        delete object._originalOpacity;
                    }
                    object.getObjects().forEach((child) => {
                        if (child._originalStroke) {
                            child.stroke = child._originalStroke;
                            delete child._originalStroke;
                        }
                        if (child._originalOpacity !== undefined) {
                            child.opacity = child._originalOpacity;
                            delete child._originalOpacity;
                        }
                    });
                }
            });
        }
    } finally {
        canvas.setViewportTransform(originalVpt);
        canvas.backgroundColor = originalBg;
        objectStates.forEach((state) => {
            state.object.set({
                visible: state.visible,
                stroke: state.stroke,
                fill: state.fill,
                opacity: state.opacity
            });
        });
        frame.visible = true;
        canvas.requestRenderAll();
    }

    const initBlob = await dataToBlob(initDataURL);
    const maskBlob = maskDataURL ? await dataToBlob(maskDataURL) : null;

    return {
        image: initBlob,
        mask: maskBlob,
        width,
        height
    };
};
