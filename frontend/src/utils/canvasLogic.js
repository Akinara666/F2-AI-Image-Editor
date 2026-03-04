import { fabric } from 'fabric';

export const enforceCanvasLayerOrder = (canvas, genFrame) => {
    if (!canvas) return;

    const objects = canvas.getObjects();
    const isFrame = (obj) => genFrame && obj === genFrame;
    const isMaskOverlay = (obj) => obj.id === 'maskGroup' || obj.isMask;
    const isContentPath = (obj) => obj.type === 'path' && !obj.isMask; // sketches + erasers
    const isCandidate = (obj) => !!obj.isCandidate;

    const baseObjects = objects.filter(obj => !isFrame(obj) && !isMaskOverlay(obj) && !isCandidate(obj) && !isContentPath(obj));
    const candidateObjects = objects.filter(obj => !isFrame(obj) && isCandidate(obj));
    const contentPaths = objects.filter(obj => !isFrame(obj) && isContentPath(obj));
    const maskOverlays = objects.filter(obj => !isFrame(obj) && isMaskOverlay(obj));

    // Desired order (bottom → top): base images → candidates → content paths → mask overlay → frame
    baseObjects.forEach(obj => obj.bringToFront());
    candidateObjects.forEach(obj => obj.bringToFront());
    contentPaths.forEach(obj => obj.bringToFront());
    maskOverlays.forEach(obj => obj.bringToFront());
    if (genFrame) genFrame.bringToFront();
};

export const mergeCanvasLayers = (canvas, candidate, genFrame, onComplete) => {
    if (!candidate || !canvas) return;

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

    // Remove eraser paths — they created the transparent area that was just
    // filled by generation.  Keeping them would punch holes in the new image.
    const eraserPaths = canvas.getObjects().filter(obj => obj.isEraser);
    eraserPaths.forEach(obj => canvas.remove(obj));
    
    enforceCanvasLayerOrder(canvas, genFrame);

    canvas.requestRenderAll();
    
    if (onComplete) onComplete(eraserPaths);
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
    // Calculate effective size including scale
    const width = Math.round(frame.width * frame.scaleX);
    const height = Math.round(frame.height * frame.scaleY);

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
        
        // Check for explicit standalone masks or paths within maskGroup
        const maskGroup = canvas.getObjects().find(o => o.id === 'maskGroup');
        const hasExplicitMasks = (maskGroup && maskGroup.getObjects().length > 0) || objectStates.some(s => s.obj.isMask);
        const hasSketches = objectStates.some(s => s.obj.type === 'path' && !s.obj.isMask && !s.obj.isEraser);

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
            if (obj.isMask || obj.id === 'maskGroup') obj.visible = false;
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
                
                // If it's the mask group, we need to process its children
                if (obj.id === 'maskGroup') {
                    obj.visible = true;
                    obj._originalOpacity = obj.opacity;
                    obj.opacity = 1.0; // Make group fully opaque
                    
                    obj.getObjects().forEach(child => {
                        child._originalOpacity = child.opacity;
                        child.opacity = 1.0;
                        if (child.stroke !== 'white') {
                            child._originalStroke = child.stroke;
                            child.stroke = 'white';
                        }
                    });
                } else if (obj.isMask) {
                    // Fallback for standalone masks (if any)
                    obj.visible = true;
                    // Ensure the mask is fully opaque for the export
                    obj._originalOpacity = obj.opacity;
                    obj.opacity = 1.0;
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
                if (obj.id === 'maskGroup') {
                    if (obj._originalOpacity !== undefined) {
                        obj.opacity = obj._originalOpacity;
                        delete obj._originalOpacity;
                    }
                    obj.getObjects().forEach(child => {
                        if (child._originalStroke) {
                            child.stroke = child._originalStroke;
                            delete child._originalStroke;
                        }
                        if (child._originalOpacity !== undefined) {
                            child.opacity = child._originalOpacity;
                            delete child._originalOpacity;
                        }
                    });
                } else {
                    if (obj._originalStroke) {
                        obj.stroke = obj._originalStroke;
                        delete obj._originalStroke;
                    }
                    if (obj._originalOpacity !== undefined) {
                        obj.opacity = obj._originalOpacity;
                        delete obj._originalOpacity;
                    }
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
