import React, { useEffect, useRef, useState, useImperativeHandle, forwardRef } from 'react';
import { fabric } from 'fabric';

/**
 * Editor Component for AI Image Generation
 */
const Editor = forwardRef(({ brushMode, brushColor, brushSize }, ref) => {
    const canvasRef = useRef(null);
    const wrapperRef = useRef(null);
    const [fabricCanvas, setFabricCanvas] = useState(null);
    const [genFrame, setGenFrame] = useState(null);

    // Initialize Fabric Canvas
    useEffect(() => {
        if (!canvasRef.current || !wrapperRef.current) return;
        
        const canvas = new fabric.Canvas(canvasRef.current, {
            width: wrapperRef.current.clientWidth,
            height: wrapperRef.current.clientHeight,
            backgroundColor: '#1e1e1e',
            isDrawingMode: false,
            enableRetinaScaling: false, 
            preserveObjectStacking: true
        });

        setFabricCanvas(canvas);

        fabric.Object.prototype.toObject = (function(toObject) {
            return function() {
                return fabric.util.object.extend(toObject.call(this), {
                    isMask: this.isMask
                });
            };
        })(fabric.Object.prototype.toObject);


        // --- Default Content & Events (Zoom/Pan) ---
        // Add a draggable Generation Frame (512x512)
        const frame = new fabric.Rect({
            left: 100,
            top: 100,
            width: 512,
            height: 512,
            fill: 'rgba(0, 0, 0, 0)', // Transparent
            stroke: '#00d4ff',
            strokeWidth: 2,
            strokeDashArray: [10, 5],
            hasBorders: true,
            hasControls: false, 
            lockRotation: true,
            lockScalingX: true,
            lockScalingY: true,
            label: 'generation_frame',
            hoverCursor: 'move'
        });
        canvas.add(frame);
        setGenFrame(frame);

        // Zoom
        canvas.on('mouse:wheel', function(opt) {
            var delta = opt.e.deltaY;
            var zoom = canvas.getZoom();
            zoom *= 0.999 ** delta;
            if (zoom > 20) zoom = 20;
            if (zoom < 0.1) zoom = 0.1;
            canvas.zoomToPoint({ x: opt.e.offsetX, y: opt.e.offsetY }, zoom);
            opt.e.preventDefault();
            opt.e.stopPropagation();
        });

        // Pan
        let isDragging = false;
        let lastPosX, lastPosY;
        canvas.on('mouse:down', function(opt) {
            if (opt.e.altKey === true) {
                isDragging = true;
                canvas.selection = false;
                lastPosX = opt.e.clientX;
                lastPosY = opt.e.clientY;
            }
        });
        canvas.on('mouse:move', function(opt) {
            if (isDragging) {
                var e = opt.e;
                var vpt = canvas.viewportTransform;
                vpt[4] += e.clientX - lastPosX;
                vpt[5] += e.clientY - lastPosY;
                canvas.requestRenderAll();
                lastPosX = e.clientX;
                lastPosY = e.clientY;
            }
        });
        canvas.on('mouse:up', function(opt) {
            canvas.setViewportTransform(canvas.viewportTransform);
            isDragging = false;
            canvas.selection = true;
        });
        
        window.addEventListener('resize', () => {
             if(wrapperRef.current){
                canvas.setWidth(wrapperRef.current.clientWidth);
                canvas.setHeight(wrapperRef.current.clientHeight);
             }
        });

        return () => canvas.dispose();
    }, []);

    // --- Brush Handling ---
    useEffect(() => {
        if (!fabricCanvas) return;

        if (brushMode === 'none') {
            fabricCanvas.isDrawingMode = false;
            fabricCanvas.selection = true;
            // Restore selectability
            fabricCanvas.getObjects().forEach(obj => {
                // Keep frame unselectable as per its init logic
                if (obj === genFrame) {
                    obj.selectable = true; 
                    obj.evented = true;
                } else {
                    obj.selectable = true;
                    obj.evented = true;
                }
            });
        } else {
            fabricCanvas.isDrawingMode = true;
            fabricCanvas.selection = false; // Disable group selection
            
            // Disable interaction with objects so clicks go to brush
            fabricCanvas.getObjects().forEach(obj => {
                obj.selectable = false;
                obj.evented = false; 
            });

            const brush = new fabric.PencilBrush(fabricCanvas);
            brush.width = brushSize;
            
            if (brushMode === 'mask') {
                brush.color = 'rgba(255, 0, 0, 0.5)';
            } else {
                brush.color = brushColor;
            }
            fabricCanvas.freeDrawingBrush = brush;
        }
        fabricCanvas.requestRenderAll();
    }, [brushMode, brushColor, brushSize, fabricCanvas, genFrame]);

    // Tag paths created in mask mode
    useEffect(() => {
        if (!fabricCanvas) return;
        
        const handlePathCreated = (e) => {
            if (brushMode === 'mask') {
                e.path.set({ 
                    isMask: true
                });
            } else {
                e.path.set({ isMask: false });
            }
            fabricCanvas.requestRenderAll();
        };

        fabricCanvas.on('path:created', handlePathCreated);
        return () => fabricCanvas.off('path:created', handlePathCreated);
    }, [fabricCanvas, brushMode]);


    // --- Helper Logic ---
    const performUndo = () => {
        if (!fabricCanvas || !genFrame) return;
        const objects = fabricCanvas.getObjects();
        if (objects.length > 0) {
            // Let's filter out the frame first to be safe, or just check the last one.
            const lastObj = objects[objects.length - 1];
            
            if (lastObj !== genFrame) {
                fabricCanvas.remove(lastObj);
            } else {
                // find the last object that is NOT the frame.
                for (let i = objects.length - 1; i >= 0; i--) {
                    if (objects[i] !== genFrame) {
                        fabricCanvas.remove(objects[i]);
                        break; // Only remove one
                    }
                }
            }
        }
    };

    // --- Exposed Methods ---
    useImperativeHandle(ref, () => ({
        
        // Add Result
        addGeneratedImage: (url) => {
            if (!fabricCanvas || !genFrame) return;
            
            // Get frame position
            const left = genFrame.left;
            const top = genFrame.top;

            fabric.Image.fromURL(url, (img) => {
                // Calculate scale to fit the frame exactly
                const displayWidth = genFrame.width * genFrame.scaleX;
                const displayHeight = genFrame.height * genFrame.scaleY;
                
                const scaleX = displayWidth / img.width;
                const scaleY = displayHeight / img.height;

                img.set({
                    left: left,
                    top: top,
                    scaleX: scaleX, // Computed to fit exactly
                    scaleY: scaleY,
                    selectable: true,
                    lockScalingX: true, // Prevent accidental resizing
                    lockScalingY: true
                });
                fabricCanvas.add(img);
                fabricCanvas.setActiveObject(img);
                
                // --- Reorder Layers ---
                // We want: Images (Bottom) -> Masks/Paths (Middle) -> Frame (Top)
                
                // 1. Bring all paths (Sketches/Masks) to front
                fabricCanvas.getObjects().forEach(obj => {
                    if (obj.type === 'path' || obj.isMask) {
                        obj.bringToFront();
                    }
                });

                // 2. Ensure frame is always on top
                genFrame.bringToFront();
                
                fabricCanvas.requestRenderAll();
            });
        },

        // Export Logic
        exportForGeneration: async () => {
            if (!fabricCanvas || !genFrame) throw new Error("Canvas invalid");

            const rect = genFrame;
            const left = rect.left;
            const top = rect.top;
            const width = rect.width;
            const height = rect.height;

            // Helper to get Blob from DataURL
            const dataToBlob = async (dataURL) => {
                const res = await fetch(dataURL);
                return await res.blob();
            };

            // State Storage
            const originalVpt = [...fabricCanvas.viewportTransform];
            const originalBg = fabricCanvas.backgroundColor;
            
            // Snapshot all object states strictly
            const objectStates = fabricCanvas.getObjects().map(obj => ({
                obj: obj,
                visible: obj.visible,
                stroke: obj.stroke,
                fill: obj.fill,
                opacity: obj.opacity
            }));

            let initDataURL = null;
            let maskDataURL = null;

            try {
                // 1. Reset Viewport
                fabricCanvas.viewportTransform = [1, 0, 0, 1, 0, 0];

                // 2. Prepare for Init Image (Hide Masks, Hide Frame, TRANSPARENT BG)
                rect.visible = false;
                fabricCanvas.backgroundColor = null; // Important: Transparent background
                
                fabricCanvas.getObjects().forEach(obj => {
                    if (obj.isMask) {
                        obj.visible = false;
                    }
                });
                
                initDataURL = fabricCanvas.toDataURL({
                    format: 'png',
                    left: left, top: top, width: width, height: height,
                    multiplier: 1
                });

                // 3. Prepare for Mask (Black BG, White Masks, Hide others)
                const hasMasks = objectStates.some(s => s.obj.isMask);
                
                if (hasMasks) {
                    fabricCanvas.backgroundColor = 'black'; // Opaque Black for Mask
                    fabricCanvas.getObjects().forEach(obj => {
                        if (obj === rect) {
                            obj.visible = false;
                            return;
                        }
                        if (obj.isMask) {
                            obj.visible = true;
                            // Force White Opaque
                            obj.set({
                                stroke: '#ffffff',
                                fill: '',
                                opacity: 1
                            });
                        } else {
                            obj.visible = false; 
                        }
                    });

                    maskDataURL = fabricCanvas.toDataURL({
                        format: 'png',
                        left: left, top: top, width: width, height: height,
                        multiplier: 1
                    });
                }

            } finally {
                // RESTORATION (Guaranteed)
                fabricCanvas.setViewportTransform(originalVpt);
                fabricCanvas.backgroundColor = originalBg;
                
                objectStates.forEach(state => {
                    state.obj.set({
                        visible: state.visible,
                        stroke: state.stroke,
                        fill: state.fill,
                        opacity: state.opacity
                    });
                });
                // Ensure frame is visible
                rect.visible = true; 
                
                fabricCanvas.requestRenderAll();
            }

            // 4. Convert to Blobs
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
        },

        // --- History / Actions ---
        undo: performUndo,

        clearAll: () => {
             if (!fabricCanvas) return;
             // Remove only brush strokes (paths)
             const objects = fabricCanvas.getObjects();
             // iterate backwards to avoid index issues
             for (let i = objects.length - 1; i >= 0; i--) {
                 const obj = objects[i];
                 if (obj !== genFrame && obj.type === 'path') {
                     fabricCanvas.remove(obj);
                 }
             }
        }
    }));

    // Ctrl+Z Listener
    useEffect(() => {
        const handleKeyDown = (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
                e.preventDefault();
                performUndo();
            }
            // Delete key to remove active selection
            if (e.key === 'Delete' || e.key === 'Backspace') {
                 if(fabricCanvas && fabricCanvas.getActiveObject()) {
                     const activeString = fabricCanvas.getActiveObject();
                     if (activeString !== genFrame) {
                         fabricCanvas.remove(activeString);
                         fabricCanvas.discardActiveObject();
                     }
                 }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [fabricCanvas, genFrame]);

    return (
        <div 
            ref={wrapperRef} 
            style={{ width: '100%', height: '100%', backgroundColor: '#222', position: 'relative', overflow: 'hidden' }}
        >
            <canvas ref={canvasRef} />
        </div>
    );
});

export default Editor;
