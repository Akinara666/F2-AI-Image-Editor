import { fabric } from 'fabric';

export const getObjectWorldBounds = (object) => ({
    left: object.left ?? 0,
    top: object.top ?? 0,
    width: Math.max(1, Math.round((object.width ?? 0) * (object.scaleX ?? 1))),
    height: Math.max(1, Math.round((object.height ?? 0) * (object.scaleY ?? 1)))
});

export const intersectsBrushCircle = (point, radius, bounds) => (
    point.x >= bounds.left - radius
    && point.x <= bounds.left + bounds.width + radius
    && point.y >= bounds.top - radius
    && point.y <= bounds.top + bounds.height + radius
);

export const worldPointToLocal = (object, point) => ({
    x: (point.x - (object.left ?? 0)) / (object.scaleX || 1),
    y: (point.y - (object.top ?? 0)) / (object.scaleY || 1)
});

export const cloneCanvasElement = (sourceElement) => {
    const next = fabric.util.createCanvasElement();
    next.width = sourceElement.width;
    next.height = sourceElement.height;
    const context = next.getContext('2d');
    if (context) {
        context.drawImage(sourceElement, 0, 0);
    }
    return next;
};

export const ensureWritableCanvasElement = (object) => {
    const element = typeof object.getElement === 'function'
        ? object.getElement()
        : object?._element;
    if (!element) {
        return null;
    }

    if (element instanceof HTMLCanvasElement) {
        return element;
    }

    const width = Math.max(
        1,
        Math.round(
            object.width
            || element.naturalWidth
            || element.videoWidth
            || element.width
            || 1
        )
    );
    const height = Math.max(
        1,
        Math.round(
            object.height
            || element.naturalHeight
            || element.videoHeight
            || element.height
            || 1
        )
    );

    const writableCanvas = fabric.util.createCanvasElement();
    writableCanvas.width = width;
    writableCanvas.height = height;
    const context = writableCanvas.getContext('2d');
    if (context) {
        context.drawImage(element, 0, 0, width, height);
    }

    if (typeof object.setElement === 'function') {
        object.setElement(writableCanvas);
    } else {
        object._element = writableCanvas;
        object._originalElement = writableCanvas;
    }

    object.set({
        dirty: true,
        objectCaching: false
    });

    return writableCanvas;
};
