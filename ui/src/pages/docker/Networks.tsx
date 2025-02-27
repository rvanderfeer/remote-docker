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
import InfoIcon from '@mui/icons-material/Info';
import { Environment, ExtensionSettings } from '../../App';

// Network interface
interface Network {
  id: string;
  name: string;
  driver: string;
  scope: string;
  ipamDriver: string;
  subnet: string;
  gateway: string;
  internal: boolean;
}

// Error response interface
interface ErrorResponse {
  error: string;
  output?: string;
}

interface NetworksProps {
  activeEnvironment?: Environment;
  settings: ExtensionSettings;
}

const client = createDockerDesktopClient();

function useDockerDesktopClient() {
  return client;
}

const Networks: React.FC<NetworksProps> = ({ activeEnvironment, settings }) => {
  const [networks, setNetworks] = useState<Network[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const ddClient = useDockerDesktopClient();

  // Load networks when active environment changes
  useEffect(() => {
    if (activeEnvironment) {
      loadNetworks();
    } else {
      // Clear networks if no environment is selected
      setNetworks([]);
    }
  }, [activeEnvironment]);

  // Load networks from the active environment
  const loadNetworks = async () => {
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

      // Make API call to fetch networks
      const response = await ddClient.extension.vm.service.post('/networks/list', {
        hostname: activeEnvironment.hostname,
        username: activeEnvironment.username,
      });

      // Check for error response
      if (response && typeof response === 'object' && 'error' in response) {
        const errorResponse = response as ErrorResponse;
        throw new Error(errorResponse.error);
      }

      // Cast response to Network array
      const networkData = response as Network[];
      setNetworks(networkData);
      console.log('Networks loaded:', networkData);
    } catch (err: any) {
      console.error('Failed to load networks:', err);
      setError(`Failed to load networks: ${err.message || 'Unknown error'}`);
      setNetworks([]);
    } finally {
      setIsLoading(false);
    }
  };

  // Delete a network
  const deleteNetwork = async (networkId: string) => {
    if (!activeEnvironment) return;

    setIsLoading(true);
    try {
      if (!ddClient.extension?.vm?.service) {
        throw new Error('Docker Desktop service not available');
      }

      const response = await ddClient.extension.vm.service.post('/networks/remove', {
        hostname: activeEnvironment.hostname,
        username: activeEnvironment.username,
        networkId
      });

      if (response && typeof response === 'object' && 'error' in response) {
        const errorResponse = response as ErrorResponse;
        throw new Error(errorResponse.error);
      }

      // Reload networks after successful operation
      await loadNetworks();
    } catch (err: any) {
      console.error('Failed to delete network:', err);
      setError(`Failed to delete network: ${err.message || 'Unknown error'}`);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
        <Typography variant="h5">Networks</Typography>

        <Box>
          <Button
            variant="contained"
            onClick={loadNetworks}
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
          Please select an environment to view networks.
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

      {/* Networks table */}
      {!isLoading && activeEnvironment && networks.length > 0 ? (
        <TableContainer component={Paper}>
          <Table sx={{ minWidth: 650 }}>
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>ID</TableCell>
                <TableCell>Driver</TableCell>
                <TableCell>Scope</TableCell>
                <TableCell>Subnet</TableCell>
                <TableCell>Gateway</TableCell>
                <TableCell>Type</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {networks.map((network) => (
                <TableRow key={network.id} hover>
                  <TableCell>{network.name}</TableCell>
                  <TableCell sx={{ fontFamily: 'monospace' }}>
                    {network.id.substring(0, 12)}
                  </TableCell>
                  <TableCell>{network.driver}</TableCell>
                  <TableCell>{network.scope}</TableCell>
                  <TableCell>{network.subnet || 'N/A'}</TableCell>
                  <TableCell>{network.gateway || 'N/A'}</TableCell>
                  <TableCell>
                    <Chip
                      label={network.internal ? 'Internal' : 'External'}
                      color={network.internal ? 'default' : 'primary'}
                      size="small"
                      variant="outlined"
                    />
                  </TableCell>
                  <TableCell align="right">
                    <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <Tooltip title="Inspect">
                        <IconButton
                          size="small"
                          color="primary"
                          disabled={isLoading}
                          sx={{ mr: 1 }}
                        >
                          <InfoIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Delete">
                        <IconButton
                          size="small"
                          color="error"
                          onClick={() => deleteNetwork(network.id)}
                          disabled={isLoading}
                        >
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </Box>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      ) : !isLoading && activeEnvironment ? (
        <Alert severity="info">
          No networks found in the selected environment.
        </Alert>
      ) : null}
    </Box>
  );
};

export default Networks;