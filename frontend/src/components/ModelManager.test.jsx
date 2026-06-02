import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import ModelManager from './ModelManager';

vi.mock('axios');

const baseProps = (overrides = {}) => ({
    open: true,
    onClose: vi.fn(),
    availableModels: [
        { id: 'model-alpha', label: 'Model Alpha', family: 'sd', source: 'cloud' },
        { id: 'model-beta', label: 'Model Beta', family: 'sdxl', source: 'cloud' },
        { id: '/m/local.safetensors', label: 'local.safetensors (Local)', family: 'sd', source: 'local', filename: 'local.safetensors', size_mb: 2048 }
    ],
    activeModelId: 'model-alpha',
    onSelectModel: vi.fn(),
    onModelsRefresh: vi.fn(),
    showToastError: vi.fn(),
    showToastSuccess: vi.fn(),
    showToastInfo: vi.fn(),
    ...overrides
});

describe('ModelManager', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('ничего не рендерит при open=false', () => {
        const { container } = render(<ModelManager {...baseProps({ open: false })} />);
        expect(container.firstChild).toBeNull();
    });

    it('показывает установленные модели и выбирает неактивную', () => {
        const props = baseProps();
        render(<ModelManager {...props} />);

        expect(screen.getByText('Model Alpha')).toBeInTheDocument();
        expect(screen.getByText('Model Beta')).toBeInTheDocument();

        const selectButtons = screen.getAllByRole('button', { name: 'Выбрать' });
        // alpha — активная (кнопка disabled), beta — доступна.
        const enabled = selectButtons.find((b) => !b.disabled);
        fireEvent.click(enabled);
        expect(props.onSelectModel).toHaveBeenCalledWith('model-beta');
    });

    it('ищет на Civit.ai и стартует загрузку', async () => {
        axios.get.mockResolvedValue({
            data: {
                results: [
                    {
                        source: 'civitai',
                        id: '123',
                        name: 'CoolXL',
                        family: 'sdxl',
                        base_model: 'SDXL 1.0',
                        thumbnail: null,
                        download_url: 'http://dl/cool',
                        filename: 'coolxl.safetensors',
                        size_bytes: 2048 * 1024,
                        auth: 'civitai'
                    }
                ]
            }
        });
        axios.post.mockResolvedValue({
            data: { job_id: 'j1', filename: 'coolxl.safetensors', status: 'downloading', progress: 0.3, speed_bps: 0 }
        });

        const props = baseProps();
        render(<ModelManager {...props} />);

        fireEvent.click(screen.getByRole('button', { name: 'Civit.ai' }));
        fireEvent.change(screen.getByPlaceholderText(/Civit\.ai/), { target: { value: 'xl' } });
        fireEvent.click(screen.getByRole('button', { name: 'Найти' }));

        await waitFor(() => expect(screen.getByText('CoolXL')).toBeInTheDocument());
        expect(axios.get).toHaveBeenCalledWith(
            expect.stringContaining('/models/search/civitai'),
            { params: { query: 'xl' } }
        );

        fireEvent.click(screen.getByRole('button', { name: 'Скачать' }));

        await waitFor(() => expect(axios.post).toHaveBeenCalled());
        const [, body] = axios.post.mock.calls[0];
        expect(body).toMatchObject({ filename: 'coolxl.safetensors', auth: 'civitai', download_url: 'http://dl/cool' });

        // Активная загрузка с прогресс-баром.
        await waitFor(() => expect(screen.getByText('30%')).toBeInTheDocument());
    });

    it('удаляет локальную модель после подтверждения', async () => {
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        axios.post.mockResolvedValue({ data: { status: 'deleted', filename: 'local.safetensors' } });

        const props = baseProps();
        render(<ModelManager {...props} />);

        fireEvent.click(screen.getByRole('button', { name: 'Удалить' }));

        await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
            expect.stringContaining('/models/delete'),
            { filename: 'local.safetensors' }
        ));
        expect(props.onModelsRefresh).toHaveBeenCalled();
    });
});
