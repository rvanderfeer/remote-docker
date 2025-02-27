package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io/ioutil"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	"github.com/sirupsen/logrus"
)

var logger = logrus.New()

type SSHConnectionRequest struct {
	Hostname string `json:"hostname"`
	Username string `json:"username"`
}

type DockerContainer struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Image  string `json:"image"`
	Status string `json:"status"`
}

// Settings data file path
const settingsFilePath = "/root/.docker-extension/settings.json"

func main() {
	var socketPath string
	flag.StringVar(&socketPath, "socket", "/run/guest-services/backend.sock", "Unix domain socket to listen on")
	flag.Parse()

	_ = os.RemoveAll(socketPath)

	logger.SetOutput(os.Stdout)

	logMiddleware := middleware.LoggerWithConfig(middleware.LoggerConfig{
		Skipper: middleware.DefaultSkipper,
		Format: `{"time":"${time_rfc3339_nano}","id":"${id}",` +
			`"method":"${method}","uri":"${uri}",` +
			`"status":${status},"error":"${error}"` +
			`}` + "\n",
		CustomTimeFormat: "2006-01-02 15:04:05.00000",
		Output:           logger.Writer(),
	})

	logger.Infof("Starting listening on %s\n", socketPath)
	router := echo.New()
	router.HideBanner = true
	router.Use(logMiddleware)
	startURL := ""

	ln, err := listen(socketPath)
	if err != nil {
		logger.Fatal(err)
	}
	router.Listener = ln

	router.GET("/hello", hello)
	router.POST("/connect", connectToRemoteDocker)
	// Get settings
	router.GET("/settings", getSettings)
	// Save settings
	router.POST("/settings", saveSettings)

	logger.Fatal(router.Start(startURL))
}

// Get settings from file
func getSettings(ctx echo.Context) error {
	// Ensure directory exists
	os.MkdirAll(filepath.Dir(settingsFilePath), 0755)

	// Check if settings file exists
	if _, err := os.Stat(settingsFilePath); os.IsNotExist(err) {
		// Return default settings if no settings exist yet
		defaultSettings := map[string]interface{}{
			"environments": []interface{}{},
			"autoConnect":  false,
		}
		jsonData, _ := json.Marshal(defaultSettings)
		return ctx.String(http.StatusOK, string(jsonData))
	}

	// Read settings file
	data, err := ioutil.ReadFile(settingsFilePath)
	if err != nil {
		logger.Errorf("Error reading settings: %v", err)
		return ctx.JSON(http.StatusInternalServerError, map[string]string{
			"error": "Failed to read settings",
		})
	}

	// Return settings data
	return ctx.String(http.StatusOK, string(data))
}

// Save settings to file
func saveSettings(ctx echo.Context) error {
	// Read request body
	body, err := ioutil.ReadAll(ctx.Request().Body)
	if err != nil {
		logger.Errorf("Error reading request body: %v", err)
		return ctx.JSON(http.StatusBadRequest, map[string]string{
			"error": "Failed to read request body",
		})
	}

	// Validate JSON
	var jsonData interface{}
	if err := json.Unmarshal(body, &jsonData); err != nil {
		logger.Errorf("Invalid JSON: %v", err)
		return ctx.JSON(http.StatusBadRequest, map[string]string{
			"error": "Invalid JSON format",
		})
	}

	// Ensure directory exists
	os.MkdirAll(filepath.Dir(settingsFilePath), 0755)

	// Write settings to file
	if err := ioutil.WriteFile(settingsFilePath, body, 0644); err != nil {
		logger.Errorf("Error writing settings: %v", err)
		return ctx.JSON(http.StatusInternalServerError, map[string]string{
			"error": "Failed to save settings",
		})
	}

	return ctx.JSON(http.StatusOK, map[string]string{
		"success": "true",
	})
}

func connectToRemoteDocker(ctx echo.Context) error {
	var req SSHConnectionRequest
	if err := ctx.Bind(&req); err != nil {
		return ctx.JSON(http.StatusBadRequest, map[string]string{"error": "Invalid request format"})
	}

	// The key issue is here - we need to pass the docker command as a single quoted string to SSH
	sshCommand := fmt.Sprintf("%s@%s", req.Username, req.Hostname)
	// Notice the single quotes around the docker command - this preserves the format string
	dockerCommand := "docker ps --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}'"

	cmd := exec.Command("ssh", "-o", "StrictHostKeyChecking=no", sshCommand, dockerCommand)

	logger.Infof("Executing command: ssh -o StrictHostKeyChecking=no %s %s", sshCommand, dockerCommand)

	output, err := cmd.CombinedOutput()
	if err != nil {
		logger.Errorf("Error executing SSH command: %v, output: %s", err, string(output))
		return ctx.JSON(http.StatusInternalServerError, map[string]string{
			"error":  fmt.Sprintf("Failed to connect: %v", err),
			"output": string(output),
		})
	}

	// Parse the output into container objects
	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	containers := make([]DockerContainer, 0, len(lines))

	for _, line := range lines {
		if line == "" {
			continue
		}

		parts := strings.Split(line, "|")
		if len(parts) != 4 {
			logger.Errorf("Invalid format for container info: %s", line)
			continue
		}

		container := DockerContainer{
			ID:     parts[0],
			Name:   parts[1],
			Image:  parts[2],
			Status: parts[3],
		}
		containers = append(containers, container)
	}

	return ctx.JSON(http.StatusOK, containers)
}

func listen(path string) (net.Listener, error) {
	return net.Listen("unix", path)
}

func hello(ctx echo.Context) error {
	return ctx.JSON(http.StatusOK, HTTPMessageBody{Message: "hello"})
}

type HTTPMessageBody struct {
	Message string
}
