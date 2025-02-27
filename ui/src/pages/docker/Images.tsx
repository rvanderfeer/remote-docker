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

// Image interface
interface Image {
  id: string;
  repository: string;
  tag: string;
  size: string;
  created: string;
}

// Error response interface
interface ErrorResponse {
  error: string;
  output?: string;
}

interface ImagesProps {
  activeEnvironment?: Environment;
  settings: ExtensionSettings;
}

const client = createDockerDesktopClient();

function useDockerDesktopClient() {
  return client;
}

const Images: React.FC<ImagesProps> = ({ activeEnvironment, settings }) => {
  const [images, setImages] = useState<Image[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const ddClient = useDockerDesktopClient();

  // Load images when active environment changes
  useEffect(() => {
    if (activeEnvironment) {
      loadImages();
    } else {
      // Clear images if no environment is selected
      setImages([]);
    }
  }, [activeEnvironment]);

  // Load images from the active environment
  const loadImages = async () => {
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

      // Make API call to fetch images
      const response = await ddClient.extension.vm.service.post('/images/list', {
        hostname: activeEnvironment.hostname,
        username: activeEnvironment.username,
      });

      // Check for error response
      if (response && typeof response === 'object' && 'error' in response) {
        const errorResponse = response as ErrorResponse;
        throw new Error(errorResponse.error);
      }

      // For now, we're assuming this endpoint isn't implemented yet
      // So we'll handle it gracefully with a custom message
      // This should be replaced with actual implementation
      if (!response || !Array.isArray(response)) {
        setImages([]);
        setError('Images API endpoint not implemented yet');
        return;
      }

      // Cast response to Image array
      const imageData = response as Image[];
      setImages(imageData);
      console.log('Images loaded:', imageData);
    } catch (err: any) {
      console.error('Failed to load images:', err);
      setError(`Failed to load images: ${err.message || 'Unknown error'}`);
      setImages([]);
    } finally {
      setIsLoading(false);
    }
  };

  // Format byte size to human-readable format
  const formatSize = (bytes: string): string => {
    const size = parseInt(bytes, 10);
    if (isNaN(size)) return 'Unknown';

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let formattedSize = size;

    while (formattedSize >= 1024 && i < units.length - 1) {
      formattedSize /= 1024;
      i++;
    }

    return `${formattedSize.toFixed(2)} ${units[i]}`;
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
        <Typography variant="h5">Images</Typography>

        <Box>
          <Button
            variant="contained"
            onClick={loadImages}
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
          Please select an environment to view images.
        </Alert>
      ) : null}

      {/* Error message */}
      {error ? (
        <Alert severity="warning" sx={{ mb: 3 }}>
          {error}
        </Alert>
      ) : null}

      {/* Loading indicator */}
      {isLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', my: 3 }}>
          <CircularProgress />
        </Box>
      ) : null}

      {/* Images table - this is a placeholder as the actual API doesn't exist yet */}
      {!isLoading && activeEnvironment && images.length > 0 ? (
        <TableContainer component={Paper}>
          <Table sx={{ minWidth: 650 }}>
            <TableHead>
              <TableRow>
                <TableCell width="20%">Repository</TableCell>
                <TableCell width="15%">Tag</TableCell>
                <TableCell width="15%">Image ID</TableCell>
                <TableCell width="20%">Created</TableCell>
                <TableCell width="20%">Size</TableCell>
                <TableCell width="10%" align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {images.map((image) => (
                <TableRow key={image.id} hover>
                  <TableCell>{image.repository}</TableCell>
                  <TableCell>
                    <Chip
                      label={image.tag || 'latest'}
                      size="small"
                      variant="outlined"
                    />
                  </TableCell>
                  <TableCell sx={{ fontFamily: 'monospace' }}>
                    {image.id.substring(0, 12)}
                  </TableCell>
                  <TableCell>{image.created}</TableCell>
                  <TableCell>{formatSize(image.size)}</TableCell>
                  <TableCell align="right">
                    <Tooltip title="Remove">
                      <IconButton
                        size="small"
                        color="error"
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
      ) : !isLoading && activeEnvironment && !error ? (
        <Alert severity="info">
          No images found in the selected environment.
        </Alert>
      ) : null}

      {/* Note about implementation status */}
      <Typography variant="caption" sx={{ display: 'block', mt: 4, color: 'text.secondary' }}>
        Note: The Images API endpoint needs to be implemented in your backend.
        You'll need to add a new route in your Go backend to fetch image data from remote Docker.
      </Typography>
    </Box>
  );
};

export default Images;