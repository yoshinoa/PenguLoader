@echo off
setlocal

echo === Building plugins ===
cd plugins
call pnpm install || goto :fail
call pnpm run build || goto :fail
cd ..

echo.
echo === Building core ===
msbuild pengu.sln -t:build -p:Configuration=Release -p:Platform=x64 -nologo -m || goto :fail

echo.
echo === Building loader ===
cd loader
call pnpm install || goto :fail
call pnpm run tauri build || goto :fail
cd ..

echo.
echo === Copying output to bin\ ===
if not exist bin mkdir bin
copy /Y "loader\src-tauri\target\release\Pengu Loader.exe" bin\ || goto :fail

echo.
echo Build complete! Output is in bin\
goto :end

:fail
echo.
echo Build failed.
exit /b 1

:end
endlocal
