import React, { useEffect, useRef, useState, useImperativeHandle, forwardRef } from 'react';
import { fabric } from 'fabric';
import { mergeCanvasLayers, exportCanvasState, enforceCanvasLayerOrder } from '../utils/canvasLogic';
import { CANVAS_DEFAULTS } from '../constants';

const MAX_UNDO_STEPS = 50;

/**
 * Editor Component for AI Image Generation
 */
const Editor = forwardRef(({ brushMode, brushColor, brushSize }, ref) => {
    const canvasRef = useRef(null);
    const wrapperRef = useRef(null);
    const [fabricCanvas, setFabricCanvas] = useState(null);
    const [genFrame, setGenFrame] = useState(null);
    const brushModeRef = useRef(brushMode);

    // History Stack for robust undo (capped at MAX_UNDO_STEPS)
    const undoStackRef = useRef([]);
    const pushUndo = (action) => {
        undoStackRef.current.push(action);
        if (undoStackRef.current.length > MAX_UNDO_STEPS) {
            undoStackRef.current.splice(0, undoStackRef.current.length - MAX_UNDO_STEPS);
        }
    };

    // Staging / Candidates
    const [candidate, setCandidate] = useState(null); // The Fabric Object
    const [candidateUrl, setCandidateUrl] = useState(null); // For UI Feedback if needed

    const [genDimensions, setGenDimensions] = useState({ width: CANVAS_DEFAULTS.DEFAULT_WIDTH, height: CANVAS_DEFAULTS.DEFAULT_HEIGHT });

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
            backgroundColor: null, // Transparent inside Fabric so destination-out reveals the div below
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
            width: CANVAS_DEFAULTS.DEFAULT_WIDTH,
            height: CANVAS_DEFAULTS.DEFAULT_HEIGHT,
            fill: 'rgba(0, 0, 0, 0)', // Transparent
            stroke: CANVAS_DEFAULTS.FRAME_COLOR,
            strokeWidth: 2,
            strokeDashArray: [10, 5],
            hasBorders: true,
            hasControls: true, // Allow resizing
            lockRotation: true,
            lockScalingX: false,
            lockScalingY: false,
            label: 'generation_frame',
            hoverCursor: 'input' // Indicate it's interactable
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

        // Snap to Grid (64px) for Generation Frame (Moving & Scaling)
        const GRID_SIZE = CANVAS_DEFAULTS.GRID_SIZE;

        canvas.on('object:moving', function (e) {
            if (e.target === frame) {
                e.target.set({
                    left: Math.round(e.target.left / GRID_SIZE) * GRID_SIZE,
                    top: Math.round(e.target.top / GRID_SIZE) * GRID_SIZE
                });
            }
        });

        canvas.on('object:scaling', function (e) {
            if (e.target === frame) {
                const target = e.target;

                // Snap dimensions
                const w = target.width * target.scaleX;
                const h = target.height * target.scaleY;

                const snappedW = Math.max(GRID_SIZE, Math.round(w / GRID_SIZE) * GRID_SIZE);
                const snappedH = Math.max(GRID_SIZE, Math.round(h / GRID_SIZE) * GRID_SIZE);

                // Find which corner/handle is being dragged
                const corner = e.transform ? e.transform.corner : '';

                // Calculate the new scale ratios
                const newScaleX = snappedW / target.width;
                const newScaleY = snappedH / target.height;

                // Adjust left/top position if we are scaling from the left or top handles
                // so the opposite edge stays anchored
                if (corner.includes('l')) {
                    const rightEdge = target.left + (target.width * target.scaleX);
                    target.left = rightEdge - (target.width * newScaleX);
                }
                if (corner.includes('t')) {
                    const bottomEdge = target.top + (target.height * target.scaleY);
                    target.top = bottomEdge - (target.height * newScaleY);
                }

                // Adjust scale to match snapped dimensions
                target.set({
                    scaleX: newScaleX,
                    scaleY: newScaleY
                });

                // Update State
                setGenDimensions({ width: snappedW, height: snappedH });
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
                if (obj.isMask || obj.isEraser) {
                    // Drawn paths should not be treated as distinct selectable objects by the user
                    obj.selectable = false;
                    obj.evented = false;
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

            let brush;
            if (brushMode === 'eraser' && fabric.EraserBrush) {
                brush = new fabric.EraserBrush(fabricCanvas);
                brush.width = brushSize * 2;
            } else {
                brush = new fabric.PencilBrush(fabricCanvas);
                brush.width = brushSize;

                if (brushMode === 'mask') {
                    // Draw with SOLID red so the brush is clearly visible while drawing
                    brush.color = 'rgba(255, 0, 0, 1.0)';
                } else if (brushMode === 'eraser') {
                    // To actually erase image pixels, we draw a stroke that acts as a mask
                    // using destination-out. The color doesn't matter for the final merge, 
                    // but setting it to white/black ensures maximum opacity for the cut.
                    brush.color = 'white';
                    brush.width = brushSize * 2;
                } else {
                    brush.color = brushColor;
                }
            }
            fabricCanvas.freeDrawingBrush = brush;
        }
        fabricCanvas.requestRenderAll();
    }, [brushMode, brushColor, brushSize, fabricCanvas, genFrame]);

    // Tag paths created in mask mode
    useEffect(() => {
        if (!fabricCanvas) return;

        const handlePathCreated = (e) => {
            // Use ref to get current mode without re-binding listener
            const mode = brushModeRef.current;

            if (mode === 'mask') {
                // The newly created path is solid red. 
                e.path.set({
                    isMask: true,
                    selectable: false,
                    evented: false,
                    opacity: 1.0
                });

                // Move path into the unified mask group where group opacity prevents stacking
                let maskGroup = fabricCanvas.getObjects().find(o => o.id === 'maskGroup');
                if (!maskGroup) {
                    maskGroup = new fabric.Group([], {
                        id: 'maskGroup',
                        selectable: false,
                        evented: false,
                        opacity: 0.5, // Group handles the semitransparency for all paths seamlessly
                        objectCaching: true
                    });
                    fabricCanvas.add(maskGroup);
                }

                maskGroup.addWithUpdate(e.path);
                fabricCanvas.remove(e.path);

                enforceCanvasLayerOrder(fabricCanvas, genFrame);

                pushUndo({ type: 'mask', object: e.path });
            } else if (mode === 'eraser') {
                // Set the path to use destination-out. This will make the stroke
                // punch a hole through all underlying intersecting objects on the canvas layer,
                // revealing the canvas background color (which we can export as transparent if needed).
                e.path.set({
                    isMask: false,
                    isEraser: true,
                    globalCompositeOperation: 'destination-out',
                    selectable: false,
                    evented: false
                });
                pushUndo({ type: 'path', object: e.path });
                enforceCanvasLayerOrder(fabricCanvas, genFrame);
            } else {
                e.path.set({ isMask: false });
                pushUndo({ type: 'path', object: e.path });
                enforceCanvasLayerOrder(fabricCanvas, genFrame);
            }

            fabricCanvas.requestRenderAll();
        };

        fabricCanvas.on('path:created', handlePathCreated);
        return () => fabricCanvas.off('path:created', handlePathCreated);
    }, [fabricCanvas, genFrame]); // Rely on genFrame to keep it on top


    // --- Helper Logic ---
    // --- Helper Logic ---
    const discardCandidateHelper = () => {
        if (!candidate || !fabricCanvas) return;
        fabricCanvas.remove(candidate);
        setCandidate(null);
        setCandidateUrl(null);
        fabricCanvas.requestRenderAll();
    };

    const performUndo = () => {
        if (candidate) {
            discardCandidateHelper();
            return;
        }
        if (undoStackRef.current.length > 0) {
            const lastAction = undoStackRef.current.pop();
            if (fabricCanvas) {
                if (lastAction.type === 'mask') {
                    let maskGroup = fabricCanvas.getObjects().find(o => o.id === 'maskGroup');
                    if (maskGroup) {
                        maskGroup.removeWithUpdate(lastAction.object);
                        if (maskGroup.getObjects().length === 0) {
                            fabricCanvas.remove(maskGroup);
                        }
                    }
                } else if (lastAction.type === 'path') {
                    fabricCanvas.remove(lastAction.object);
                }
                enforceCanvasLayerOrder(fabricCanvas, genFrame);
                fabricCanvas.requestRenderAll();
            }
        }
    };

    // Keep a ref to always point to the latest performUndo (avoids stale closure in keydown listener)
    const performUndoRef = useRef(performUndo);
    useEffect(() => {
        performUndoRef.current = performUndo;
    });

    // CORE LOGIC: Merge Candidate via Utils
    const performAccept = () => {
        const acceptedObj = candidate;
        mergeCanvasLayers(fabricCanvas, candidate, genFrame, () => {
            pushUndo({ type: 'accept', object: acceptedObj });
            setCandidate(null);
            setCandidateUrl(null);
        });
    };

    // --- Exposed Methods ---
    useImperativeHandle(ref, () => ({
        setGenFrameSize: (w, h) => {
            if (!genFrame || !fabricCanvas) return;
            genFrame.set({ width: w, height: h, scaleX: 1, scaleY: 1 });
            enforceCanvasLayerOrder(fabricCanvas, genFrame);
            fabricCanvas.requestRenderAll();
            setGenDimensions({ width: w, height: h });
        },

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
                    stroke: CANVAS_DEFAULTS.CANDIDATE_BORDER_COLOR, // Green border to indicate "Pending"
                    strokeWidth: 4,
                });

                fabricCanvas.add(img);
                enforceCanvasLayerOrder(fabricCanvas, genFrame);

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
            discardCandidateHelper();
        },

        // Export Logic
        exportForGeneration: async () => {
            return await exportCanvasState(fabricCanvas, genFrame);
        },

        // --- History / Actions ---
        undo: performUndo,

        clearAll: () => {
            if (!fabricCanvas) return;
            // Remove only brush strokes (paths) and maskGroup
            const objects = fabricCanvas.getObjects();
            for (let i = objects.length - 1; i >= 0; i--) {
                const obj = objects[i];
                if (obj !== genFrame && obj.type === 'path') {
                    fabricCanvas.remove(obj);
                } else if (obj.id === 'maskGroup') {
                    fabricCanvas.remove(obj);
                }
            }
            undoStackRef.current = [];
            enforceCanvasLayerOrder(fabricCanvas, genFrame);
            fabricCanvas.requestRenderAll();
        }
    }));

    // Ctrl+Z Listener
    useEffect(() => {
        const handleKeyDown = (e) => {
            // IGNORE IF TYPING IN INPUTS
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

            if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
                e.preventDefault();
                performUndoRef.current();
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
                        undoStackRef.current = undoStackRef.current.filter(act => act.object !== activeString);
                        fabricCanvas.discardActiveObject();
                        enforceCanvasLayerOrder(fabricCanvas, genFrame);
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
        <div ref={wrapperRef} style={{
            width: '100%',
            height: '100%',
            position: 'relative',
            backgroundColor: CANVAS_DEFAULTS.BG_COLOR,
            // A subtle CSS checkerboard pattern to indicate transparency
            backgroundImage: `linear-gradient(45deg, #252525 25%, transparent 25%), linear-gradient(-45deg, #252525 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #252525 75%), linear-gradient(-45deg, transparent 75%, #252525 75%)`,
            backgroundSize: `20px 20px`,
            backgroundPosition: `0 0, 0 10px, 10px -10px, -10px 0px`
        }}>
            <canvas ref={canvasRef} />

            {/* Resolution Display Badge */}
            <div style={{
                position: 'absolute',
                top: '10px',
                left: '10px',
                background: 'rgba(0, 0, 0, 0.6)',
                color: CANVAS_DEFAULTS.FRAME_COLOR, // Cyan to match frame
                padding: '5px 10px',
                borderRadius: '4px',
                pointerEvents: 'none',
                fontWeight: 'bold',
                fontSize: '14px',
                backdropFilter: 'blur(4px)',
                border: `1px solid ${CANVAS_DEFAULTS.FRAME_COLOR}4D`
            }}>
                {genDimensions.width} x {genDimensions.height}
            </div>

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
                        onClick={discardCandidateHelper}
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
