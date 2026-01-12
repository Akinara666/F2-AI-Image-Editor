import React, { useEffect, useRef, useState, useImperativeHandle, forwardRef } from 'react';
import { fabric } from 'fabric';

/**
 * Editor Component for AI Image Generation
 * Now supports: Generation Frame, Brush Modes, Smart Export, Layer Stacking.
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
            isDrawingMode: false
        });

        setFabricCanvas(canvas);

        // --- Custom Properties ---
        // Allow distinguishing mask strokes
        fabric.Object.prototype.toObject = (function(toObject) {
            return function() {
                return fabric.util.object.extend(toObject.call(this), {
                    isMask: this.isMask
                });
            };
        })(fabric.Object.prototype.toObject);


        // --- Default Content ---
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
            hasControls: false, // Cannot resize, only move
            lockRotation: true,
            lockScalingX: true,
            lockScalingY: true,
            label: 'generation_frame',
            hoverCursor: 'move'
        });
        canvas.add(frame);
        setGenFrame(frame);

        // --- Events ---
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

        // Pan (Alt+Drag)
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
        
        // Resize handle
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
        } else {
            fabricCanvas.isDrawingMode = true;
            const brush = new fabric.PencilBrush(fabricCanvas);
            brush.width = brushSize;
            
            if (brushMode === 'mask') {
                // Visualization for Mask: Red semi-transparent
                // BUT we need to tag it. Fabric doesn't easily let us tag the path *before* creation using interactions.
                // We use the 'path:created' event fallback logic.
                brush.color = 'rgba(255, 0, 0, 0.5)';
            } else {
                brush.color = brushColor;
            }
            fabricCanvas.freeDrawingBrush = brush;
        }
    }, [brushMode, brushColor, brushSize, fabricCanvas]);

    // Tag paths created in mask mode
    useEffect(() => {
        if (!fabricCanvas) return;
        
        const handlePathCreated = (e) => {
            if (brushMode === 'mask') {
                e.path.set({ isMask: true, globalCompositeOperation: 'source-over' });
                // We want masks to be on top? Or handled specially.
            } else {
                e.path.set({ isMask: false });
            }
        };

        fabricCanvas.on('path:created', handlePathCreated);
        return () => fabricCanvas.off('path:created', handlePathCreated);
    }, [fabricCanvas, brushMode]);


    // --- Exposed Methods ---
    useImperativeHandle(ref, () => ({
        
        // Add Result
        addGeneratedImage: (url) => {
            if (!fabricCanvas || !genFrame) return;
            
            // Get frame position
            const left = genFrame.left;
            const top = genFrame.top;

            fabric.Image.fromURL(url, (img) => {
                img.set({
                    left: left,
                    top: top,
                    selectable: true
                });
                fabricCanvas.add(img);
                fabricCanvas.setActiveObject(img);
                
                // Ensure frame is always on top for next generation
                genFrame.bringToFront();
            });
        },

        // Export Logic
        exportForGeneration: async () => {
            if (!fabricCanvas || !genFrame) throw new Error("Canvas invalid");

            const rect = genFrame;
            const left = rect.left;
            const top = rect.top;
            const width = rect.width; // Fixed 512
            const height = rect.height;

            // Helper to get Blob from DataURL
            const dataToBlob = async (dataURL) => {
                const res = await fetch(dataURL);
                return await res.blob();
            };

            // 1. Export INIT IMAGE (Everything EXCEPT Mask brushes and Frame)
            // Hide Frame
            rect.visible = false;
            
            // Hide Masks
            const maskObjects = [];
            fabricCanvas.getObjects().forEach(obj => {
                if (obj.isMask) {
                    obj.visible = false;
                    maskObjects.push(obj);
                }
            });
            fabricCanvas.renderAll();

            // Check if empty (simple check: is there anything relevant under rect?)
            // We'll export anyway and let the backend/user logic decide, 
            // OR we can check if the crop is fully transparent.
            
            const initDataURL = fabricCanvas.toDataURL({
                format: 'png',
                left: left, top: top, width: width, height: height,
                multiplier: 1
            });
            
            const initBlob = await dataToBlob(initDataURL);

            // Restore Masks
            maskObjects.forEach(obj => obj.visible = true);
            
            // 2. Export MASK (Only Mask objects, White on Black)
            // To do this, we need to hide everything else, change bg to black, change masks to white.
            // This is visually disruptive. Better to stick to a clone/temp canvas approach?
            // For MVP: fast flicker is acceptable or use filtering.
            
            // Let's rely on backend 'mask_image' ONLY if we actually have masks.
            let maskBlob = null;
            if (maskObjects.length > 0) {
                 // Save current states
                 const originalBg = fabricCanvas.backgroundColor;
                 const objectStates = fabricCanvas.getObjects().map(o => ({ obj: o, visible: o.visible, color: o.stroke || o.fill }));
                 
                 // Setup for Mask Export
                 fabricCanvas.backgroundColor = 'black';
                 fabricCanvas.getObjects().forEach(obj => {
                     if (obj === rect) {
                         obj.visible = false;
                         return;
                     }
                     if (obj.isMask) {
                         obj.visible = true;
                         obj.stroke = 'white'; // Paths use stroke
                         obj.fill = 'white';
                     } else {
                         obj.visible = false; // Hide images/sketches
                     }
                 });
                 fabricCanvas.renderAll();
                 
                 const maskDataURL = fabricCanvas.toDataURL({
                    format: 'png',
                    left: left, top: top, width: width, height: height,
                    multiplier: 1
                 });
                 maskBlob = await dataToBlob(maskDataURL);
                 
                 // Restore
                 fabricCanvas.backgroundColor = originalBg;
                 objectStates.forEach((state, i) => {
                     const obj = fabricCanvas.item(i);
                     obj.visible = state.visible;
                     if(obj.isMask) {
                         // Restore red visualization
                         obj.stroke = 'rgba(255, 0, 0, 0.5)';
                     }
                 });
                 rect.visible = true; // Show frame again
                 fabricCanvas.renderAll();
            } else {
                rect.visible = true; // Show frame if no masks processed
            }

            return {
                image: initBlob,
                mask: maskBlob,
                width,
                height
            };
        },

        // --- History / Actions ---
        undo: () => {
            if (!fabricCanvas) return;
            // Remove the last added object, BUT skip the Frame (which is usually the first or special)
            // We should remove the last object in the list
            const objects = fabricCanvas.getObjects();
            if (objects.length > 0) {
                const lastObj = objects[objects.length - 1];
                // Don't delete the Generation Frame
                if (lastObj !== genFrame) {
                    fabricCanvas.remove(lastObj);
                }
            }
        },

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
                // Access undo via a local function or ref if possible, 
                // but since we are inside the component we can just copy logic or use a stable callback.
                // Since 'undo' logic depends on 'fabricCanvas' and 'genFrame' state which are in scope:
                if (fabricCanvas) {
                    const objects = fabricCanvas.getObjects();
                    if (objects.length > 0) {
                        const lastObj = objects[objects.length - 1];
                        if (lastObj !== genFrame) {
                            fabricCanvas.remove(lastObj);
                        }
                    }
                }
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
