export const FRAME_STROKE_WIDTH = 3;
export const FRAME_DASH_PATTERN = [10, 5];

export const blobToDataURL = (blob) => (
    new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Failed to convert blob to data URL.'));
        reader.readAsDataURL(blob);
    })
);

export const snapshotObjectTransform = (object) => ({
    left: object.left,
    top: object.top,
    width: object.width,
    height: object.height,
    scaleX: object.scaleX,
    scaleY: object.scaleY,
    angle: object.angle,
    flipX: object.flipX,
    flipY: object.flipY
});

export const areTransformsEqual = (left, right) => (
    left.left === right.left
    && left.top === right.top
    && left.width === right.width
    && left.height === right.height
    && left.scaleX === right.scaleX
    && left.scaleY === right.scaleY
    && left.angle === right.angle
    && left.flipX === right.flipX
    && left.flipY === right.flipY
);

export const serializeFrameState = (object) => ({
    left: object.left,
    top: object.top,
    width: object.width,
    height: object.height,
    scaleX: object.scaleX,
    scaleY: object.scaleY,
    angle: object.angle,
    visible: object.visible
});

export const serializeFrameVisualState = (object) => ({
    ...serializeFrameState(object),
    strokeWidth: object.strokeWidth,
    strokeDashArray: Array.isArray(object.strokeDashArray) ? [...object.strokeDashArray] : object.strokeDashArray
});

export const applyFrameViewportStyle = (frameVisualObject, zoomLevel) => {
    if (!frameVisualObject) return;
    const safeZoom = Math.max(zoomLevel || 1, 0.1);
    frameVisualObject.set({
        strokeWidth: FRAME_STROKE_WIDTH / safeZoom,
        strokeDashArray: FRAME_DASH_PATTERN.map((segment) => segment / safeZoom)
    });
};
