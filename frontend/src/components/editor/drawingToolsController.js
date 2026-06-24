import { fabric } from 'fabric';
import { TOOL_MODES } from './toolModes';

const GUIDE_STYLE = {
    stroke: '#00d4ff',
    strokeWidth: 1,
    strokeUniform: true,
    strokeDashArray: [5, 4],
    selectable: false,
    evented: false,
    hasControls: false,
    hasBorders: false,
    objectCaching: false,
    excludeFromExport: true,
    editorRole: 'selection-overlay'
};

const MIN_SHAPE_SIZE = 3;

// Текст, фигуры, заливка, градиент и пипетка. Векторные объекты (текст,
// фигуры) живут как нативные Fabric-объекты с ролью BASE — они сплющиваются
// во все экспортные пути. Пиксельные операции (fill/gradient/eyedropper)
// делегируются колбэкам Editor.
export const setupDrawingToolHandling = ({
    canvas,
    frameObject,
    brushModeRef,
    brushColorRef,
    setBrushModeRef,
    textOptionsRef,
    shapeOptionsRef,
    clampPointToFrame,
    canvasObjectRoles,
    enforceCanvasLayerOrder,
    markUndoDirty,
    commitUndoSnapshot,
    getUndoSnapshotParams,
    onFillPoint,
    onGradientApply,
    onEyedropperPoint
}) => {
    if (!canvas || !frameObject) {
        return () => {};
    }

    let shapeDraft = null;
    let shapeAnchor = null;
    let gradientGuide = null;
    let gradientStart = null;

    const removeShapeDraft = () => {
        if (shapeDraft) {
            canvas.remove(shapeDraft);
            shapeDraft = null;
        }
    };

    const removeGradientGuide = () => {
        if (gradientGuide) {
            canvas.remove(gradientGuide);
            gradientGuide = null;
        }
    };

    const placeText = (pointer) => {
        const fontSize = Math.max(8, Number(textOptionsRef.current?.fontSize) || 32);
        const text = new fabric.IText('', {
            left: pointer.x,
            top: pointer.y,
            fontFamily: 'Inter, sans-serif',
            fontSize,
            fill: brushColorRef.current,
            editorRole: canvasObjectRoles.BASE,
            editorLayerName: 'Text',
            objectCaching: false,
            selectable: true,
            evented: true
        });
        canvas.add(text);
        enforceCanvasLayerOrder(canvas, frameObject);
        // Переключаемся на курсор, чтобы объект остался интерактивным
        // после выхода из редактирования.
        setBrushModeRef.current?.('none');
        canvas.setActiveObject(text);
        text.enterEditing();
        canvas.requestRenderAll();
    };

    const handleTextEditingExited = (event) => {
        const target = event.target;
        if (!target || target.type !== 'i-text') {
            return;
        }
        if (!target.text || target.text.trim() === '') {
            canvas.remove(target);
            canvas.requestRenderAll();
            return;
        }
        markUndoDirty(target);
        enforceCanvasLayerOrder(canvas, frameObject);
        commitUndoSnapshot(getUndoSnapshotParams(canvas, frameObject));
    };

    const buildShapeDraft = (pointer) => {
        const options = shapeOptionsRef.current || {};
        const color = brushColorRef.current;
        const strokeWidth = Math.max(1, Number(options.strokeWidth) || 2);
        const baseProps = {
            objectCaching: false,
            selectable: false,
            evented: false,
            editorRole: canvasObjectRoles.BASE,
            editorLayerName: 'Shape'
        };

        if (options.kind === 'line') {
            return new fabric.Line([pointer.x, pointer.y, pointer.x, pointer.y], {
                ...baseProps,
                stroke: color,
                strokeWidth
            });
        }

        const fillProps = options.outlineOnly
            ? { fill: 'transparent', stroke: color, strokeWidth }
            : { fill: color, stroke: null, strokeWidth: 0 };

        if (options.kind === 'ellipse') {
            return new fabric.Ellipse({
                ...baseProps,
                ...fillProps,
                left: pointer.x,
                top: pointer.y,
                rx: 0.5,
                ry: 0.5,
                originX: 'left',
                originY: 'top'
            });
        }

        return new fabric.Rect({
            ...baseProps,
            ...fillProps,
            left: pointer.x,
            top: pointer.y,
            width: 1,
            height: 1
        });
    };

    const updateShapeDraft = (pointer) => {
        if (!shapeDraft || !shapeAnchor) {
            return;
        }
        if (shapeDraft.type === 'line') {
            shapeDraft.set({ x2: pointer.x, y2: pointer.y });
        } else {
            const left = Math.min(shapeAnchor.x, pointer.x);
            const top = Math.min(shapeAnchor.y, pointer.y);
            const width = Math.max(1, Math.abs(pointer.x - shapeAnchor.x));
            const height = Math.max(1, Math.abs(pointer.y - shapeAnchor.y));
            if (shapeDraft.type === 'ellipse') {
                shapeDraft.set({ left, top, rx: width / 2, ry: height / 2 });
            } else {
                shapeDraft.set({ left, top, width, height });
            }
        }
        shapeDraft.setCoords();
        canvas.requestRenderAll();
    };

    const finalizeShapeDraft = (pointer) => {
        if (!shapeDraft || !shapeAnchor) {
            return;
        }
        const shape = shapeDraft;
        shapeDraft = null;

        const dx = Math.abs(pointer.x - shapeAnchor.x);
        const dy = Math.abs(pointer.y - shapeAnchor.y);
        const isLine = shape.type === 'line';
        const tooSmall = isLine
            ? dx < MIN_SHAPE_SIZE && dy < MIN_SHAPE_SIZE
            : dx < MIN_SHAPE_SIZE || dy < MIN_SHAPE_SIZE;
        if (tooSmall) {
            canvas.remove(shape);
            canvas.requestRenderAll();
            return;
        }

        markUndoDirty(shape);
        enforceCanvasLayerOrder(canvas, frameObject);
        canvas.requestRenderAll();
        commitUndoSnapshot(getUndoSnapshotParams(canvas, frameObject));
    };

    const handleMouseDown = (event) => {
        const mode = brushModeRef.current;
        if (event.e.button !== 0) {
            return;
        }
        const rawPointer = canvas.getPointer(event.e);
        if (!rawPointer) {
            return;
        }

        if (mode === TOOL_MODES.TEXT) {
            event.e.preventDefault();
            placeText(clampPointToFrame(rawPointer));
            return;
        }

        if (mode === TOOL_MODES.SHAPE) {
            event.e.preventDefault();
            shapeAnchor = clampPointToFrame(rawPointer);
            shapeDraft = buildShapeDraft(shapeAnchor);
            canvas.add(shapeDraft);
            enforceCanvasLayerOrder(canvas, frameObject);
            canvas.requestRenderAll();
            return;
        }

        if (mode === TOOL_MODES.FILL) {
            event.e.preventDefault();
            onFillPoint?.(clampPointToFrame(rawPointer));
            return;
        }

        if (mode === TOOL_MODES.GRADIENT) {
            event.e.preventDefault();
            gradientStart = clampPointToFrame(rawPointer);
            gradientGuide = new fabric.Line(
                [gradientStart.x, gradientStart.y, gradientStart.x, gradientStart.y],
                GUIDE_STYLE
            );
            canvas.add(gradientGuide);
            gradientGuide.bringToFront();
            canvas.requestRenderAll();
            return;
        }

        if (mode === TOOL_MODES.EYEDROPPER) {
            event.e.preventDefault();
            onEyedropperPoint?.(rawPointer, event.e.altKey === true);
        }
    };

    const handleMouseMove = (event) => {
        const mode = brushModeRef.current;
        const pointer = canvas.getPointer(event.e);
        if (!pointer) {
            return;
        }

        if (mode === TOOL_MODES.SHAPE && shapeDraft) {
            updateShapeDraft(clampPointToFrame(pointer));
            return;
        }

        if (mode === TOOL_MODES.GRADIENT && gradientGuide && gradientStart) {
            const clamped = clampPointToFrame(pointer);
            gradientGuide.set({ x2: clamped.x, y2: clamped.y });
            gradientGuide.setCoords();
            canvas.requestRenderAll();
        }
    };

    const handleMouseUp = (event) => {
        const mode = brushModeRef.current;

        if (shapeDraft) {
            const pointer = clampPointToFrame(canvas.getPointer(event.e)) || shapeAnchor;
            finalizeShapeDraft(pointer);
            shapeAnchor = null;
            return;
        }

        if (mode === TOOL_MODES.GRADIENT && gradientStart) {
            const start = gradientStart;
            gradientStart = null;
            removeGradientGuide();
            canvas.requestRenderAll();
            const end = clampPointToFrame(canvas.getPointer(event.e));
            if (end && (Math.abs(end.x - start.x) >= 2 || Math.abs(end.y - start.y) >= 2)) {
                onGradientApply?.(start, end);
            }
        }
    };

    canvas.on('mouse:down', handleMouseDown);
    canvas.on('mouse:move', handleMouseMove);
    canvas.on('mouse:up', handleMouseUp);
    canvas.on('text:editing:exited', handleTextEditingExited);

    return () => {
        removeShapeDraft();
        removeGradientGuide();
        canvas.off('mouse:down', handleMouseDown);
        canvas.off('mouse:move', handleMouseMove);
        canvas.off('mouse:up', handleMouseUp);
        canvas.off('text:editing:exited', handleTextEditingExited);
    };
};
