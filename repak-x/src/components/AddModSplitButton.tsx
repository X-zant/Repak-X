import React from 'react';
import Button from '@mui/material/Button';
import ButtonGroup from '@mui/material/ButtonGroup';
import type { ButtonGroupProps } from '@mui/material/ButtonGroup';
import { GrInstall } from "react-icons/gr";
import { CreateNewFolder as CreateNewFolderIcon } from '@mui/icons-material';
import { open } from '@tauri-apps/plugin-dialog';
import { styled } from '@mui/material/styles';

const StyledButtonGroup = styled(ButtonGroup)(({ theme }) => ({
    boxShadow: '0 4px 15px rgba(0,0,0,0.3)',
    borderRadius: '12px',
    // Remove the border color override so the internal borders work correctly
    '& .MuiButton-root': {
        borderColor: 'rgba(255, 255, 255, 0.2) !important',
    },
    // When the group is hovered, dim the buttons that are NOT hovered
    '&:hover .MuiButton-root:not(:hover)': {
        filter: 'brightness(0.7) grayscale(0.4)',
        opacity: 0.8,
    }
}));

const LeftButton = styled(Button)(({ theme }) => ({
    background: 'linear-gradient(45deg, var(--accent-primary), var(--accent-secondary))',
    color: 'var(--on-accent)',
    fontSize: 'var(--fs-md)',
    fontWeight: 600,
    textTransform: 'none',
    padding: '0 24px',
    borderRadius: '12px 0 0 12px !important',
    borderRight: '1px solid rgba(255,255,255,0.2) !important',
    transition: 'filter 0.2s cubic-bezier(0.4, 0, 0.2, 1), flex-grow 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
    flex: 1,
    '&:hover': {
        filter: 'brightness(1.1)',
        flex: 1.3, // Subtle grow effect on hover
    },
}));

const RightButton = styled(Button)(({ theme }) => ({
    background: 'linear-gradient(45deg, var(--accent-secondary), var(--accent-primary))',
    color: 'var(--on-accent)',
    fontSize: 'var(--fs-md)',
    fontWeight: 600,
    textTransform: 'none',
    padding: '0 24px',
    borderRadius: '0 12px 12px 0 !important',
    transition: 'filter 0.2s cubic-bezier(0.4, 0, 0.2, 1), flex-grow 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
    flex: 1,
    '&:hover': {
        filter: 'brightness(1.1)',
        flex: 1.3, // Subtle grow effect on hover
    },
}));

type AddModSplitButtonProps = Omit<ButtonGroupProps, 'onChange'> & {
    onAddFiles?: (files: string[]) => void;
    onAddFolder?: (folders: string[]) => void;
};

export default function AddModSplitButton({ onAddFiles, onAddFolder, ...rest }: AddModSplitButtonProps) {
    const handleAddFiles = async () => {
        try {
            const selected = await open({
                multiple: true,
                filters: [{
                    name: 'Mod Files',
                    extensions: ['pak', 'zip', 'rar', '7z']
                }],
                title: 'Select Mods to Install'
            });

            if (selected && onAddFiles) {
                const files = Array.isArray(selected) ? selected : [selected];
                if (files.length > 0) {
                    onAddFiles(files);
                }
            }
        } catch (err) {
            console.error("Failed to select files:", err);
        }
    };

    const handleAddFolder = async () => {
        try {
            const selected = await open({
                directory: true,
                multiple: true, // Note: Windows dialog might only support single folder selection
                title: 'Select Folder(s) to Install'
            });

            if (selected && onAddFolder) {
                const folders = Array.isArray(selected) ? selected : [selected];
                if (folders.length > 0) {
                    onAddFolder(folders);
                }
            }
        } catch (err) {
            console.error("Failed to select folder:", err);
        }
    };

    return (
        <StyledButtonGroup variant="contained" aria-label="add mods button group" {...rest}>
            <LeftButton onClick={handleAddFiles} title="Install PAKs or Archives">
                <GrInstall style={{ marginRight: '8px', fontSize: 'var(--fs-xl)' }} />
                PAK
            </LeftButton>
            <RightButton onClick={handleAddFolder} title="Install Folder (Raw/Uassets)">
                <CreateNewFolderIcon style={{ marginRight: '8px', fontSize: 'var(--fs-xl)' }} />
                Folder
            </RightButton>
        </StyledButtonGroup>
    );
}
