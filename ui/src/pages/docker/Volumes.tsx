import React, { useState, useEffect } from 'react';
import { createDockerDesktopClient } from '@docker/extension-api-client';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
  Tooltip,
  IconButton,
  Chip
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import DeleteIcon from '@mui/icons-material/Delete';
import { Environment, ExtensionSettings } from '../../App';

// Volume interface
interface Volume {
  name: string;
  driver: string;
  mountpoint: string;
  created: string;
  size: string;
  labels: string[];
}

// Error response interface
interface ErrorResponse {
  error: string;
  output?: string;
}

interface VolumesProps {
  activeEnvironment?: Environment;
  settings: ExtensionSettings;
}

const client = createDockerDesktopClient();

function useDockerDesktopClient() {
  return client;
}

const Volumes: React.FC<VolumesProps> = ({ activeEnvironment, settings }) => {
  const [volumes, setVolumes] = useState<Volume[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const ddClient = useDockerDesktopClient();

  // Load volumes when active environment changes
  useEffect(() => {
    if (activeEnvironment) {
      loadVolumes();
    } else {
      // Clear volumes if no environment is selected
      setVolumes([]);
    }
  }, [activeEnvironment]);

  // Load volumes from the active environment
  const loadVolumes = async () => {
    if (!activeEnvironment) {
      setError('No environment selected');
      return;
    }

    setIsLoading(true);
    setError('');

    try {
      // Check if Docker Desktop service is available
      if (!ddClient.extension?.vm?.service) {
        throw new Error('Docker Desktop service not available');
      }

      // Make API call to fetch volumes
      const response = await ddClient.extension.vm.service.post('/volumes/list', {
        hostname: activeEnvironment.hostname,
        username: activeEnvironment.username,
      });

      // Check for error response
      if (response && typeof response === 'object' && 'error' in response) {
        const errorResponse = response as ErrorResponse;
        throw new Error(errorResponse.error);
      }

      // Cast response to Volume array
      const volumeData = response as Volume[];
      setVolumes(volumeData);
      console.log('Volumes loaded:', volumeData);
    } catch (err: any) {
      console.error('Failed to load volumes:', err);
      setError(`Failed to load volumes: ${err.message || 'Unknown error'}`);
      setVolumes([]);
    } finally {
      setIsLoading(false);
    }
  };

  // Delete a volume
  const deleteVolume = async (volumeName: string) => {
    if (!activeEnvironment) return;

    setIsLoading(true);
    try {
      if (!ddClient.extension?.vm?.service) {
        throw new Error('Docker Desktop service not available');
      }

      const response = await ddClient.extension.vm.service.post('/volumes/remove', {
        hostname: activeEnvironment.hostname,
        username: activeEnvironment.username,
        volumeName
      });

      if (response && typeof response === 'object' && 'error' in response) {
        const errorResponse = response as ErrorResponse;
        throw new Error(errorResponse.error);
      }

      // Reload volumes after successful operation
      await loadVolumes();
    } catch (err: any) {
      console.error('Failed to delete volume:', err);
      setError(`Failed to delete volume: ${err.message || 'Unknown error'}`);
    } finally {
      setIsLoading(false);
    }
  };

  // Format volume size if available
  const formatSize = (size: string): string => {
    if (!size || size === 'N/A') return 'N/A';

    const sizeNum = parseInt(size, 10);
    if (isNaN(sizeNum)) return size;

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let formattedSize = sizeNum;

    while (formattedSize >= 1024 && i < units.length - 1) {
      formattedSize /= 1024;
      i++;
    }

    return `${formattedSize.toFixed(2)} ${units[i]}`;
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
        <Typography variant="h5">Volumes</Typography>

        <Box>
          <Button
            variant="contained"
            onClick={loadVolumes}
            disabled={isLoading || !activeEnvironment}
            startIcon={<RefreshIcon />}
          >
            Refresh
          </Button>
        </Box>
      </Box>

      {/* Warning when no environment is selected */}
      {!activeEnvironment ? (
        <Alert severity="info" sx={{ mb: 3 }}>
          Please select an environment to view volumes.
        </Alert>
      ) : null}

      {/* Error message */}
      {error ? (
        <Alert severity="error" sx={{ mb: 3 }}>
          {error}
        </Alert>
      ) : null}

      {/* Loading indicator */}
      {isLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', my: 3 }}>
          <CircularProgress />
        </Box>
      ) : null}

      {/* Volumes table */}
      {!isLoading && activeEnvironment && volumes.length > 0 ? (
        <TableContainer component={Paper}>
          <Table sx={{ minWidth: 650 }}>
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>Driver</TableCell>
                <TableCell>Mount Point</TableCell>
                <TableCell>Created</TableCell>
                <TableCell>Size</TableCell>
                <TableCell>Labels</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {volumes.map((volume) => (
                <TableRow key={volume.name} hover>
                  <TableCell>{volume.name}</TableCell>
                  <TableCell>{volume.driver}</TableCell>
                  <TableCell sx={{
                    maxWidth: 200,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}>
                    <Tooltip title={volume.mountpoint}>
                      <span>{volume.mountpoint}</span>
                    </Tooltip>
                  </TableCell>
                  <TableCell>{volume.created}</TableCell>
                  <TableCell>{formatSize(volume.size)}</TableCell>
                  <TableCell>
                    {volume.labels && volume.labels.length > 0 ? (
                      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                        {volume.labels.map((label, index) => (
                          <Chip
                            key={index}
                            label={label}
                            size="small"
                            variant="outlined"
                          />
                        ))}
                      </Box>
                    ) : (
                      "None"
                    )}
                  </TableCell>
                  <TableCell align="right">
                    <Tooltip title="Delete">
                      <IconButton
                        size="small"
                        color="error"
                        onClick={() => deleteVolume(volume.name)}
                        disabled={isLoading}
                      >
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      ) : !isLoading && activeEnvironment ? (
        <Alert severity="info">
          No volumes found in the selected environment.
        </Alert>
      ) : null}
    </Box>
  );
};

export default Volumes;