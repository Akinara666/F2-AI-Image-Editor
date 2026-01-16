import { fabric } from 'fabric';

/**
 * Removes the last added object (excluding the generation frame)
 * @param {fabric.Canvas} canvas 
 * @param {fabric.Object} protectedObject - Object to never remove (the frame)
 */
export const undoCanvasAction = (canvas, protectedObject) => {
    if (!canvas || !protectedObject) return;
    const objects = canvas.getObjects();
    if (objects.length > 0) {
        const lastObj = objects[objects.length - 1];
        if (lastObj !== protectedObject) {
            canvas.remove(lastObj);
        } else {
            // scan backwards
            for (let i = objects.length - 1; i >= 0; i--) {
                if (objects[i] !== protectedObject) {
                    canvas.remove(objects[i]);
                    break;
                }
            }
        }
    }
};

/**
 * Locks a candidate image in place (converting it to a background)
 * @param {fabric.Image} candidate 
 * @param {fabric.Canvas} canvas 
 */
export const lockCandidateObject = (candidate, canvas) => {
    candidate.set({
        selectable: true,
        evented: true,
        isCandidate: false,
        stroke: null,
        strokeWidth: 0,
        lockMovementX: true,
        lockMovementY: true,
        lockRotation: true,
        lockScalingX: true,
        lockScalingY: true,
        hasControls: false,
        hoverCursor: 'default'
    });
    canvas.sendToBack(candidate);
    canvas.requestRenderAll();
};

/**
 * Merges the candidate image with existing baked backgrounds into a single layer
 * @param {fabric.Canvas} canvas 
 * @param {fabric.Image} candidate 
 * @param {fabric.Object} genFrame 
 * @param {Function} onComplete - Callback with new merged image
 */
export const mergeCanvasLayers = (canvas, candidate, genFrame, onComplete) => {
    if (!candidate || !canvas) return;

    // 1. Find all existing locked images (backgrounds)
    const backgrounds = canvas.getObjects().filter(obj =>
        obj.type === 'image' &&
        obj !== candidate &&
        obj !== genFrame &&
        obj.lockMovementX === true
    );

    if (backgrounds.length === 0) {
        // No backgrounds to merge with, just lock the candidate
        lockCandidateObject(candidate, canvas);
        if (onComplete) onComplete();
    } else {
        // MERGE PROCESS
        let minX = candidate.left;
        let minY = candidate.top;
        let maxX = candidate.left + (candidate.width * candidate.scaleX);
        let maxY = candidate.top + (candidate.height * candidate.scaleY);

        backgrounds.forEach(bg => {
            const bgRight = bg.left + (bg.width * bg.scaleX);
            const bgBottom = bg.top + (bg.height * bg.scaleY);
            if (bg.left < minX) minX = bg.left;
            if (bg.top < minY) minY = bg.top;
            if (bgRight > maxX) maxX = bgRight;
            if (bgBottom > maxY) maxY = bgBottom;
        });

        // Hide others
        const viewportTransform = canvas.viewportTransform;
        const backgroundColor = canvas.backgroundColor;
        const objsToHide = canvas.getObjects().filter(o => !backgrounds.includes(o) && o !== candidate);
        objsToHide.forEach(o => o.visible = false);

        // Remove stroke for capture
        candidate.set({ stroke: null, strokeWidth: 0 });

        canvas.viewportTransform = [1, 0, 0, 1, 0, 0];
        canvas.backgroundColor = null;

        // Snapshot
        const dataURL = canvas.toDataURL({
            format: 'png',
            left: minX,
            top: minY,
            width: maxX - minX,
            height: maxY - minY,
            multiplier: 1,
            quality: 1
        });

        // Restore
        canvas.viewportTransform = viewportTransform;
        canvas.backgroundColor = backgroundColor;
        objsToHide.forEach(o => o.visible = true);

        // Replace
        fabric.Image.fromURL(dataURL, (img) => {
            img.set({
                left: minX,
                top: minY,
                selectable: true,
                evented: true,
                lockMovementX: true, lockMovementY: true,
                lockRotation: true, lockScalingX: true, lockScalingY: true,
                hasControls: false,
                hoverCursor: 'default'
            });

            backgrounds.forEach(bg => canvas.remove(bg));
            canvas.remove(candidate);
            canvas.add(img);
            canvas.sendToBack(img);
            canvas.requestRenderAll();
            
            if (onComplete) onComplete();
        });
    }
};

/**
 * Exports the content within the frame for generation
 * @param {fabric.Canvas} canvas 
 * @param {fabric.Object} frame 
 * @returns {Promise<{image: Blob, mask: Blob|null, width: number, height: number}>}
 */
export const exportCanvasState = async (canvas, frame) => {
    if (!canvas || !frame) throw new Error("Canvas invalid");

    const left = frame.left;
    const top = frame.top;
    const width = frame.width;
    const height = frame.height;

    const dataToBlob = async (dataURL) => {
        const res = await fetch(dataURL);
        return await res.blob();
    };

    const originalVpt = [...canvas.viewportTransform];
    const originalBg = canvas.backgroundColor;

    const objectStates = canvas.getObjects().map(obj => ({
        obj: obj,
        visible: obj.visible,
        stroke: obj.stroke,
        fill: obj.fill,
        opacity: obj.opacity
    }));

    let initDataURL = null;
    let maskDataURL = null;

    try {
        canvas.viewportTransform = [1, 0, 0, 1, 0, 0];
        
        const hasExplicitMasks = objectStates.some(s => s.obj.isMask);
        const hasSketches = objectStates.some(s => s.obj.type === 'path' && !s.obj.isMask);

        // 1. Init Image Export
        let useOpaqueBackground = false;
        if (hasExplicitMasks) {
            canvas.backgroundColor = null;
        } else if (hasSketches) {
            canvas.backgroundColor = '#808080';
            useOpaqueBackground = true;
        } else {
            canvas.backgroundColor = null;
        }

        frame.visible = false;
        canvas.getObjects().forEach(obj => {
            if (obj.isMask) obj.visible = false;
        });

        initDataURL = canvas.toDataURL({
            format: useOpaqueBackground ? 'jpeg' : 'png',
            quality: 0.95,
            left: left, top: top, width: width, height: height,
            multiplier: 1
        });

        // 2. Mask Export
        if (hasExplicitMasks) {
            canvas.backgroundColor = 'black';
            canvas.getObjects().forEach(obj => {
                if (obj === frame) {
                    obj.visible = false;
                    return;
                }
                if (obj.isMask) {
                    obj.visible = true;
                    if (obj.stroke !== 'white') {
                        obj._originalStroke = obj.stroke;
                        obj.stroke = 'white';
                    }
                } else {
                    obj.visible = false;
                }
            });

            maskDataURL = canvas.toDataURL({
                format: 'png',
                left: left, top: top, width: width, height: height,
                multiplier: 1
            });

             // Cleanup temp white strokes
            canvas.getObjects().forEach(obj => {
                if (obj._originalStroke) {
                    obj.stroke = obj._originalStroke;
                    delete obj._originalStroke;
                }
            });
        }

    } finally {
        canvas.setViewportTransform(originalVpt);
        canvas.backgroundColor = originalBg;
        objectStates.forEach(state => {
            state.obj.set({
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
    let maskBlob = null;
    if (maskDataURL) {
        maskBlob = await dataToBlob(maskDataURL);
    }

    return {
        image: initBlob,
        mask: maskBlob,
        width,
        height
    };
};
