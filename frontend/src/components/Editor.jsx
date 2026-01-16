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
    const brushModeRef = useRef(brushMode);

    // Staging / Candidates
    const [candidate, setCandidate] = useState(null); // The Fabric Object
    const [candidateUrl, setCandidateUrl] = useState(null); // For UI Feedback if needed

    // Keep ref in sync
    useEffect(() => {
        brushModeRef.current = brushMode;
    }, [brushMode]);

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

        fabric.Object.prototype.toObject = (function (toObject) {
            return function () {
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
        canvas.on('mouse:wheel', function (opt) {
            var delta = opt.e.deltaY;
            var zoom = canvas.getZoom();
            zoom *= 0.999 ** delta;
            if (zoom > 20) zoom = 20;
            if (zoom < 0.1) zoom = 0.1;
            canvas.zoomToPoint({ x: opt.e.offsetX, y: opt.e.offsetY }, zoom);
            opt.e.preventDefault();
            opt.e.stopPropagation();
        });

        // Snap to Grid (64px) for Generation Frame
        const GRID_SIZE = 64;
        canvas.on('object:moving', function (e) {
            if (e.target === frame) {
                e.target.set({
                    left: Math.round(e.target.left / GRID_SIZE) * GRID_SIZE,
                    top: Math.round(e.target.top / GRID_SIZE) * GRID_SIZE
                });
            }
        });

        // Pan
        let isDragging = false;
        let lastPosX, lastPosY;
        canvas.on('mouse:down', function (opt) {
            const evt = opt.e;
            // Allow dragging if Alt key, Hand Mode, OR SPACEBAR is pressed
            if (evt.altKey === true || brushModeRef.current === 'hand' || canvas.isSpacePanning) {
                isDragging = true;
                canvas.selection = false;
                lastPosX = evt.clientX;
                lastPosY = evt.clientY;
                canvas.defaultCursor = 'grabbing';
            }
        });
        canvas.on('mouse:move', function (opt) {
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
        canvas.on('mouse:up', function (opt) {
            canvas.setViewportTransform(canvas.viewportTransform);
            isDragging = false;
            canvas.selection = true;
            canvas.defaultCursor = 'default';
            // Restore hand cursor if in hand mode
            if (brushModeRef.current === 'hand') {
                canvas.defaultCursor = 'grab';
                canvas.selection = false;
            }
        });

        window.addEventListener('resize', () => {
            if (wrapperRef.current) {
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
        } else if (brushMode === 'hand') {
            fabricCanvas.isDrawingMode = false;
            fabricCanvas.selection = false; // Disable selection box
            fabricCanvas.defaultCursor = 'grab';
            fabricCanvas.getObjects().forEach(obj => {
                obj.selectable = false;
                obj.evented = false;
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
            } else if (brushMode === 'eraser') {
                brush.color = '#808080'; // Paint with background color (Eraser)
                brush.width = brushSize * 2; // Make eraser slightly bigger
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
            } else if (brushMode === 'eraser') {
                // Eraser strokes are just "cover up" strokes, not masks.
                // We can tag them as 'eraser' if we want special logic later.
                e.path.set({ isMask: false, isEraser: true });
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

    // Helper to lock a candidate (First image case)
    const finalizeCandidate = (cand, canvas, setCand, setUrl) => {
        cand.set({
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
        canvas.sendToBack(cand);
        setCand(null);
        setUrl(null);
        canvas.requestRenderAll();
    };

    // CORE LOGIC: Merge Candidate with existing inputs
    const performAccept = () => {
        if (!candidate || !fabricCanvas) return;

        // 1. Find all existing locked images (our "backgrounds")
        const backgrounds = fabricCanvas.getObjects().filter(obj =>
            obj.type === 'image' &&
            obj !== candidate &&
            obj !== genFrame &&
            obj.lockMovementX === true // Assume locked images are part of the background
        );

        if (backgrounds.length === 0) {
            // First image? Just convert candidate to background
            finalizeCandidate(candidate, fabricCanvas, setCandidate, setCandidateUrl);
        } else {
            // MERGE PROCESS
            // 1. Calculate bounding box of All Backgrounds + Candidate
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

            // 2. Hide everything else (Frames, Masks, etc) to ensure clean capture
            const viewportTransform = fabricCanvas.viewportTransform;
            const backgroundColor = fabricCanvas.backgroundColor;

            // Save state and hide non-backgrounds
            const objsToHide = fabricCanvas.getObjects().filter(o => !backgrounds.includes(o) && o !== candidate);
            objsToHide.forEach(o => o.visible = false);

            // REMOVE STROKE FROM CANDIDATE BEFORE CAPTURE
            candidate.set({ stroke: null, strokeWidth: 0 });

            fabricCanvas.viewportTransform = [1, 0, 0, 1, 0, 0]; // Reset zoom/pan for capture
            fabricCanvas.backgroundColor = null; // Transparent bg

            // 3. Snapshot the specific area
            const dataURL = fabricCanvas.toDataURL({
                format: 'png',
                left: minX,
                top: minY,
                width: maxX - minX,
                height: maxY - minY,
                multiplier: 1,
                quality: 1
            });

            // 4. Restore State
            fabricCanvas.viewportTransform = viewportTransform;
            fabricCanvas.backgroundColor = backgroundColor;
            objsToHide.forEach(o => o.visible = true);

            // 5. Create New Merged Image
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

                // 6. Remove Old Objects
                backgrounds.forEach(bg => fabricCanvas.remove(bg));
                fabricCanvas.remove(candidate); // Remove the candidate wrapper

                // 7. Add New Merged Object
                fabricCanvas.add(img);
                fabricCanvas.sendToBack(img); // Background layer

                setCandidate(null);
                setCandidateUrl(null);
                fabricCanvas.requestRenderAll();
            });
        }
    };

    // --- Exposed Methods ---
    useImperativeHandle(ref, () => ({

        // Add Result (Staging Phase)
        addGeneratedImage: (url) => {
            if (!fabricCanvas || !genFrame) return;

            // If there is already a candidate, remove it (replace mode)
            if (candidate) {
                fabricCanvas.remove(candidate);
                setCandidate(null);
            }

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
                    selectable: false, // Not selectable yet
                    evented: false,
                    isCandidate: true, // Tag as candidate
                    stroke: '#00ff00', // Green border to indicate "Pending"
                    strokeWidth: 4,
                });

                fabricCanvas.add(img);
                img.bringToFront();
                genFrame.bringToFront(); // Frame on top of everything

                fabricCanvas.requestRenderAll();

                // Set State to trigger UI
                setCandidate(img);
                setCandidateUrl(url);
            });
        },

        // Staging Actions
        acceptCandidate: () => {
            performAccept();
        },

        discardCandidate: () => {
            if (!candidate || !fabricCanvas) return;
            fabricCanvas.remove(candidate);
            setCandidate(null);
            setCandidateUrl(null);
            fabricCanvas.requestRenderAll();
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

                // 2. Prepare for Init Image
                // LOGIC UPDATE: Handle Sketch-to-Image vs Outpainting vs Inpainting

                const hasExplicitMasks = objectStates.some(s => s.obj.isMask);
                const hasSketches = objectStates.some(s => s.obj.type === 'path' && !s.obj.isMask);

                // Determine Export Strategy
                let useOpaqueBackground = false;

                if (hasExplicitMasks) {
                    // Scenario A: INPAINTING (Manual Mask)
                    // We need transparency for layers + Mask file.
                    fabricCanvas.backgroundColor = null;
                } else if (hasSketches) {
                    // Scenario B: SKETCH-TO-IMAGE
                    // We must export an OPAQUE image to trigger 'img2img` on backend
                    // and prevents 'auto-outpainting' (which keeps the sketch lines).
                    fabricCanvas.backgroundColor = '#808080';
                    useOpaqueBackground = true;
                } else {
                    // Scenario C: OUTPAINTING / PHOTO EDITING
                    // No masks, no sketches (or just photo). Preserve transparency to allow Outpainting.
                    fabricCanvas.backgroundColor = null;
                }

                rect.visible = false;

                // Visibility Logic for Init Image
                fabricCanvas.getObjects().forEach(obj => {
                    if (obj.isMask) {
                        obj.visible = false; // Hide Masks from Init Image
                    }
                    // Keep sketches visible (they are part of the image now)
                });

                initDataURL = fabricCanvas.toDataURL({
                    format: useOpaqueBackground ? 'jpeg' : 'png', // JPEG is always opaque, ensuring no alpha leaks
                    quality: 0.95,
                    left: left, top: top, width: width, height: height,
                    multiplier: 1
                });

                // 3. Prepare for Mask (Black BG, White Masks)
                if (hasExplicitMasks) {
                    fabricCanvas.backgroundColor = 'black'; // Opaque Black for Mask
                    fabricCanvas.getObjects().forEach(obj => {
                        if (obj === rect) {
                            obj.visible = false;
                            return;
                        }
                        if (obj.isMask) {
                            obj.visible = true; // Show Masks
                            // Force Mask Color Visuals if needed
                            if (obj.stroke !== 'white') {
                                obj._originalStroke = obj.stroke;
                                obj.stroke = 'white';
                            }
                        } else {
                            obj.visible = false; // Hide Photos & Sketches for Mask generation
                        }
                    });

                    maskDataURL = fabricCanvas.toDataURL({
                        format: 'png',
                        left: left, top: top, width: width, height: height,
                        multiplier: 1
                    });

                    // Cleanup temp white strokes
                    fabricCanvas.getObjects().forEach(obj => {
                        if (obj._originalStroke) {
                            obj.stroke = obj._originalStroke;
                            delete obj._originalStroke;
                        }
                    });
                } else {
                    maskDataURL = null; // No manual mask -> No Inpainting (unless Auto-Outpainting triggers via transparency)
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
            // IGNORE IF TYPING IN INPUTS
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

            if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
                e.preventDefault();
                performUndo();
            }
            // Spacebar Panning (Press to Pan)
            if (e.code === 'Space' && !e.repeat && brushModeRef.current !== 'hand') {
                e.preventDefault(); // Prevent scroll
                fabricCanvas.defaultCursor = 'grab';
                fabricCanvas.isDrawingMode = false; // Temp disable drawing
                fabricCanvas.selection = false;
                // Set a global flag or just rely on the 'spacePressed' state check in mouse:down
                fabricCanvas.isSpacePanning = true;
                // We specifically disable object interaction during space pan
                fabricCanvas.forEachObject(o => o.evented = false);
            }

            // Delete key to remove active selection
            if (e.key === 'Delete' || e.key === 'Backspace') {
                if (fabricCanvas && fabricCanvas.getActiveObject()) {
                    const activeString = fabricCanvas.getActiveObject();
                    if (activeString !== genFrame) {
                        fabricCanvas.remove(activeString);
                        fabricCanvas.discardActiveObject();
                    }
                }
            }
        };

        const handleKeyUp = (e) => {
            if (e.code === 'Space' && fabricCanvas.isSpacePanning) {
                fabricCanvas.defaultCursor = 'default';
                fabricCanvas.isSpacePanning = false;

                // Restore interactions
                if (brushModeRef.current !== 'hand') {
                    fabricCanvas.selection = true;
                    fabricCanvas.isDrawingMode = (brushModeRef.current !== 'none');
                    fabricCanvas.forEachObject(o => o.evented = true);
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('keyup', handleKeyUp);
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('keyup', handleKeyUp);
        };
    }, [fabricCanvas, genFrame]);

    return (
        <div
            ref={wrapperRef}
            style={{ width: '100%', height: '100%', backgroundColor: '#222', position: 'relative', overflow: 'hidden' }}
        >
            <canvas ref={canvasRef} />

            {/* Staging UI Overlay */}
            {candidateUrl && (
                <div style={{
                    position: 'absolute',
                    bottom: '20px',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    display: 'flex',
                    gap: '10px',
                    backgroundColor: 'rgba(0,0,0,0.8)',
                    padding: '10px',
                    borderRadius: '8px',
                    zIndex: 1000
                }}>
                    <button
                        onClick={() => {
                            performAccept();
                        }}
                        style={{ background: '#2a9d8f', color: '#fff', border: 'none', padding: '10px 20px', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}
                    >
                        ✓ ACCEPT
                    </button>

                    <button
                        onClick={() => {
                            if (!candidate || !fabricCanvas) return;
                            fabricCanvas.remove(candidate);
                            setCandidate(null); setCandidateUrl(null); fabricCanvas.requestRenderAll();
                        }}
                        style={{ background: '#e63946', color: '#fff', border: 'none', padding: '10px 20px', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}
                    >
                        ✕ DISCARD
                    </button>
                </div>
            )}
        </div>
    );
});

export default Editor;
