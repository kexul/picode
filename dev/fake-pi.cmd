@echo off
REM fake pi for UI debugging (see dev/fakePi.js). Used as piPath by --fake-pi.
node "%~dp0fakePi.js" %*
