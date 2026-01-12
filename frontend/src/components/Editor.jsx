import React, { useEffect, useRef, useState } from 'react';
import { fabric } from 'fabric';

/**
 * Editor Component for AI Image Generation
 * Handles Canvas initialization, Zoom/Pan, and Crop Export for Inpainting.
 */
const Editor = () => {
    const canvasRef = useRef(null);
    const wrapperRef = useRef(null);
    const [fabricCanvas, setFabricCanvas] = useState(null);
    const [selectionRect, setSelectionRect] = useState(null);

    // Initialize Fabric Canvas
    useEffect(() => {
        if (!canvasRef.current || !wrapperRef.current) return;

        const canvas = new fabric.Canvas(canvasRef.current, {
            width: wrapperRef.current.clientWidth,
            height: wrapperRef.current.clientHeight,
            backgroundColor: '#1e1e1e', // Dark theme background
            selection: true
        });

        setFabricCanvas(canvas);

        // Add a demo image
        fabric.Image.fromURL('https://via.placeholder.com/800x600', (img) => {
            if(!img) return;
            img.set({ left: 100, top: 100 });
            canvas.add(img);
            canvas.setActiveObject(img);
        });

        // Mouse Wheel Zoom
        canvas.on('mouse:wheel', function(opt) {
            var delta = opt.e.deltaY;
            var zoom = canvas.getZoom();
            zoom *= 0.999 ** delta;
            if (zoom > 20) zoom = 20;
            if (zoom < 0.01) zoom = 0.01;
            canvas.zoomToPoint({ x: opt.e.offsetX, y: opt.e.offsetY }, zoom);
            opt.e.preventDefault();
            opt.e.stopPropagation();
        });

        // Panning with Alt + Drag
        let isDragging = false;
        let lastPosX, lastPosY;

        canvas.on('mouse:down', function(opt) {
            var evt = opt.e;
            if (evt.altKey === true) {
                isDragging = true;
                canvas.selection = false;
                lastPosX = evt.clientX;
                lastPosY = evt.clientY;
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
        
        // Handle window resize
        const handleResize = () => {
            if(wrapperRef.current && canvas){
                canvas.setWidth(wrapperRef.current.clientWidth);
                canvas.setHeight(wrapperRef.current.clientHeight);
            }
        };
        window.addEventListener('resize', handleResize);

        return () => {
            canvas.dispose();
            window.removeEventListener('resize', handleResize);
        }
    }, []);

    // Function to add a selection box (Mask Area)
    const addSelectionBox = () => {
        if (!fabricCanvas) return;
        const rect = new fabric.Rect({
            left: 100,
            top: 100,
            fill: 'rgba(255, 255, 255, 0.3)',
            width: 512,
            height: 512,
            stroke: 'cyan',
            strokeWidth: 2,
            hasControls: true,
            hasBorders: true,
            transparentCorners: false,
            cornerColor: 'white',
            cornerSize: 8,
            borderColor: 'cyan'
        });
        fabricCanvas.add(rect);
        fabricCanvas.setActiveObject(rect);
        setSelectionRect(rect);
    };

    /**
     * CRITICAL: Export Crop considering Zoom and Viewport Transform.
     */
    const exportCropForGeneration = () => {
        if (!fabricCanvas || !selectionRect) {
            alert("No selection rectangle found!");
            return;
        }
        
        const rect = selectionRect;
        const left = rect.left;
        const top = rect.top;
        const width = rect.getScaledWidth();
        const height = rect.getScaledHeight();

        // Hide rect for export
        rect.visible = false;
        
        // Use multiplier: 1 to get the crop at canvas's virtual resolution (1:1), ignoring Zoom
        // This gives us the underlying "working" resolution image
        const generationCrop = fabricCanvas.toDataURL({
            format: 'png',
            left: left,
            top: top,
            width: width,
            height: height,
            multiplier: 1, 
        });
        
        rect.visible = true; // Show it again
        
        console.log("Exported Crop URL length: ", generationCrop.length);
        console.log("For Inpainting, send this Base64 as init_image.");
        
        return generationCrop;
    };

    return (
        <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '10px', background: '#333', color: '#fff', display: 'flex', gap: '10px', alignItems: 'center' }}>
                <h3>AI Editor v0.1</h3>
                <button onClick={addSelectionBox}>Add Selection (512x512)</button>
                <button onClick={exportCropForGeneration}>
                    Export Selection (for Server)
                </button>
                <span style={{fontSize: '0.8em', color: '#aaa'}}>Alt + Drag to Pan | Scroll to Zoom</span>
            </div>
            
            <div 
                ref={wrapperRef} 
                style={{ flex: 1, backgroundColor: '#222', position: 'relative', overflow: 'hidden' }}
            >
                <canvas ref={canvasRef} />
            </div>
        </div>
    );
};

export default Editor;
