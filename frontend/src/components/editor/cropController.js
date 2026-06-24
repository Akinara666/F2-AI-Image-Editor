import { TOOL_MODES } from './toolModes';

const MIN_CROP_SIZE = 8;

// Кадрирование: drag задаёт рамку, Editor рисует затемнение и применяет
// crop по Enter/кнопке. Рамка хранится у Editor (onCropDraft/onCropCommit).
export const setupCropToolHandling = ({
    canvas,
    brushModeRef,
    onCropDraft,
    onCropCommit
}) => {
    if (!canvas) {
        return () => {};
    }

    let anchor = null;
    let isDragging = false;

    const rectFromPoints = (start, end) => ({
        left: Math.round(Math.min(start.x, end.x)),
        top: Math.round(Math.min(start.y, end.y)),
        width: Math.max(1, Math.round(Math.abs(end.x - start.x))),
        height: Math.max(1, Math.round(Math.abs(end.y - start.y)))
    });

    const handleMouseDown = (event) => {
        if (brushModeRef.current !== TOOL_MODES.CROP || event.e.button !== 0) {
            return;
        }
        const pointer = canvas.getPointer(event.e);
        if (!pointer) {
            return;
        }
        event.e.preventDefault();
        event.e.stopPropagation();
        anchor = pointer;
        isDragging = true;
    };

    const handleMouseMove = (event) => {
        if (!isDragging || brushModeRef.current !== TOOL_MODES.CROP) {
            return;
        }
        const pointer = canvas.getPointer(event.e);
        if (!pointer) {
            return;
        }
        onCropDraft?.(rectFromPoints(anchor, pointer));
    };

    const handleMouseUp = (event) => {
        if (!isDragging) {
            return;
        }
        isDragging = false;
        const pointer = canvas.getPointer(event.e) || anchor;
        const rect = rectFromPoints(anchor, pointer);
        anchor = null;
        if (rect.width < MIN_CROP_SIZE || rect.height < MIN_CROP_SIZE) {
            onCropCommit?.(null);
            return;
        }
        onCropCommit?.(rect);
    };

    canvas.on('mouse:down', handleMouseDown);
    canvas.on('mouse:move', handleMouseMove);
    canvas.on('mouse:up', handleMouseUp);

    return () => {
        canvas.off('mouse:down', handleMouseDown);
        canvas.off('mouse:move', handleMouseMove);
        canvas.off('mouse:up', handleMouseUp);
    };
};
