// src/pages/docker/Volumes.tsx
import React from 'react';
import { Box, Typography, Alert } from '@mui/material';
import { Environment, ExtensionSettings } from '../../App';

interface VolumesProps {
  activeEnvironment?: Environment;
  settings: ExtensionSettings;
}

const Volumes: React.FC<VolumesProps> = ({ activeEnvironment }) => {
  return (
    <Box>
      <Typography variant="h5" gutterBottom>Volumes</Typography>
      <Alert severity="info">
        This is a placeholder for the Volumes page. You would implement similar functionality to the
        Containers page here, showing a list of volumes from the selected environment.
      </Alert>
    </Box>
  );
};

export default Volumes;
