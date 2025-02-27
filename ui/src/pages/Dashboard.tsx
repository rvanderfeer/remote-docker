import React, { useState, useEffect } from 'react';
import Button from '@mui/material/Button';
import { createDockerDesktopClient } from '@docker/extension-api-client';
import {
  Alert,
  Box,
  CircularProgress,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  SelectChangeEvent,
  Stack,
  Table, TableBody, TableCell,
  TableContainer,
  TableHead, TableRow,
  TextField,
  Typography,
  useTheme
} from '@mui/material';
import { Environment, ExtensionSettings } from '../App';

// Note: This line relies on Docker Desktop's presence as a host application.
const client = createDockerDesktopClient();

function useDockerDesktopClient() {
  return client;
}

interface Container {
  id: string;
  name: string;
  image: string;
  status: string;
}

// Define the error response interface
interface ErrorResponse {
  error: string;
  output?: string;
}

interface DashboardProps {
  activeEnvironment?: Environment;
  settings: ExtensionSettings;
  onSetActiveEnvironment: (environmentId: string | undefined) => Promise<void>;
}

const Dashboard: React.FC<DashboardProps> = ({
                                               activeEnvironment,
                                               settings,
                                               onSetActiveEnvironment
                                             }) => {
  const theme = useTheme();
  const [hostname, setHostname] = useState('');
  const [username, setUsername] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [containers, setContainers] = useState<Container[]>([]);

  const ddClient = useDockerDesktopClient();

  // Update form when active environment changes
  useEffect(() => {
    if (activeEnvironment) {
      setHostname(activeEnvironment.hostname);
      setUsername(activeEnvironment.username);

      // Auto-connect if enabled
      if (settings.autoConnect) {
        connectToRemoteDocker();
      }
    }
  }, [activeEnvironment, settings.autoConnect]);

  const connectToRemoteDocker = async () => {
    if (!hostname || !username) {
      setError('Hostname and username are required');
      return;
    }

    setIsLoading(true);
    setError('');
    setContainers([]);

    try {
      // Make sure both extension and vm and service are defined before calling
      if (!ddClient.extension?.vm?.service) {
        throw new Error('Docker Desktop service not available');
      }

      const response = await ddClient.extension.vm.service.post('/connect', {
        hostname,
        username,
      });

      // Explicitly check if the response has an error property
      if (response && typeof response === 'object' && 'error' in response) {
        const errorResponse = response as ErrorResponse;
        throw new Error(errorResponse.error);
      }

      // Type assertion for the successful case
      const containerData = response as Container[];
      setContainers(containerData);

      console.log('Connected successfully:', containerData);
    } catch (err: any) {
      console.error('Connection failed:', err);
      setError(`Connection failed: ${err.message || 'Unknown error'}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleEnvironmentChange = (event: SelectChangeEvent<string>) => {
    const envId = event.target.value;
    onSetActiveEnvironment(envId === "none" ? undefined : envId);
  };

  return (
    <Box>
      <Typography variant="h4" gutterBottom>
        Remote Docker Dashboard
      </Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 4 }}>
        Connect to a remote Docker daemon using SSH and view containers.
      </Typography>

      <Paper sx={{ p: 3, mb: 4 }}>
        <Typography variant="h6" gutterBottom>
          Connection Details
        </Typography>

        <Stack direction="column" spacing={3}>
          {/* Environment selector */}
          {settings.environments.length > 0 && (
            <FormControl fullWidth>
              <InputLabel id="environment-select-label">Environment</InputLabel>
              <Select
                labelId="environment-select-label"
                id="environment-select"
                value={settings.activeEnvironmentId || "none"}
                label="Environment"
                onChange={handleEnvironmentChange}
              >
                <MenuItem value="none">-- Select Environment --</MenuItem>
                {settings.environments.map((env) => (
                  <MenuItem key={env.id} value={env.id}>{env.name}</MenuItem>
                ))}
              </Select>
            </FormControl>
          )}

          <TextField
            label="Hostname"
            fullWidth
            value={hostname}
            onChange={(e) => setHostname(e.target.value)}
            placeholder="e.g., my-server.example.com or 192.168.1.100"
          />

          <TextField
            label="Username"
            fullWidth
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="SSH username"
          />

          <Typography variant="body2" color="text.secondary">
            This extension will use your SSH key from ~/.ssh/ to authenticate.
          </Typography>

          {error && (
            <Alert severity="error">{error}</Alert>
          )}

          <Button
            variant="contained"
            onClick={connectToRemoteDocker}
            disabled={isLoading}
            sx={{ alignSelf: 'flex-start' }}
          >
            {isLoading && <CircularProgress size="small" sx={{ mr: 1 }} />}
            {isLoading ? 'Connecting...' : 'Connect & List Containers'}
          </Button>
        </Stack>
      </Paper>

      {containers.length > 0 ? (
        <Box>
          <Typography variant="h6" gutterBottom>
            Remote Containers
          </Typography>

          <TableContainer component={Paper}>
            <Table sx={{ minWidth: 650 }}>
              <TableHead>
                <TableRow>
                  <TableCell>Container ID</TableCell>
                  <TableCell>Name</TableCell>
                  <TableCell>Image</TableCell>
                  <TableCell>Status</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {containers.map((container) => (
                  <TableRow key={container.id} hover>
                    <TableCell sx={{ fontFamily: 'monospace' }}>
                      {container.id.substring(0, 12)}
                    </TableCell>
                    <TableCell>{container.name}</TableCell>
                    <TableCell>{container.image}</TableCell>
                    <TableCell
                      sx={{
                        color: container.status.toLowerCase().includes('up')
                          ? 'success.main'
                          : 'text.secondary'
                      }}
                    >
                      {container.status}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Box>
      ) : isLoading ? null : (
        <Alert severity="info" sx={{ mt: 2 }}>
          No containers to display. Connect to a remote Docker daemon to view containers.
        </Alert>
      )}
    </Box>
  );
};

export default Dashboard;