import { fabric } from 'fabric';

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
    
    // We leave candidate's z-index where it is (above older backgrounds)
    // but ensure drawn paths and the generation frame stay on top.
    const objects = canvas.getObjects();
    objects.forEach(obj => {
        if (obj.type === 'path') {
            obj.bringToFront();
        }
    });

    if (genFrame) {
        genFrame.bringToFront();
    }

    canvas.requestRenderAll();
    
    if (onComplete) onComplete();
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
