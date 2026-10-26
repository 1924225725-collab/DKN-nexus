param(
    [Parameter(Mandatory=$true)][string]$ExecutablePath,
    [switch]$NormalizeIntegrity
)

$ErrorActionPreference='Stop'
$projectRoot=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$exe=(Resolve-Path -LiteralPath $ExecutablePath).Path
if(!$exe.StartsWith($projectRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetExtension($exe) -ne '.exe') {
    throw 'Only an explicitly named EXE inside this project may be checked or normalized.'
}

if(-not ('DknReleaseFileLabel' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class DknReleaseFileLabel {
    [DllImport("advapi32.dll", EntryPoint="GetNamedSecurityInfoW", CharSet=CharSet.Unicode)]
    static extern uint GetNamedSecurityInfo(string name,int type,uint info,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetAce(IntPtr acl,int index,out IntPtr ace);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid,uint index);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    public static int IntegrityRid(string path) {
        IntPtr owner,group,dacl,sacl,descriptor;
        uint error=GetNamedSecurityInfo(path,1,0x10,out owner,out group,out dacl,out sacl,out descriptor);
        if(error!=0) throw new Win32Exception((int)error);
        try {
            if(sacl==IntPtr.Zero) return 8192;
            int count=(ushort)Marshal.ReadInt16(sacl,4);
            for(int i=0;i<count;i++) {
                IntPtr ace;
                if(!GetAce(sacl,i,out ace)) throw new Win32Exception(Marshal.GetLastWin32Error());
                if(Marshal.ReadByte(ace)!=0x11) continue;
                IntPtr sid=IntPtr.Add(ace,8);
                byte parts=Marshal.ReadByte(GetSidSubAuthorityCount(sid));
                return Marshal.ReadInt32(GetSidSubAuthority(sid,(uint)(parts-1)));
            }
            return 8192;
        } finally { LocalFree(descriptor); }
    }
}
'@
}

$before=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash
if($NormalizeIntegrity) {
    & icacls.exe $exe /setintegritylevel Medium | Out-Host
    if($LASTEXITCODE -ne 0){throw 'Could not set Medium integrity. Run this step from a normal Windows user terminal.'}
}
$rid=[DknReleaseFileLabel]::IntegrityRid($exe)
if($rid -ne 8192){throw "Release EXE has integrity RID $rid (expected Medium/8192). Run this script with -NormalizeIntegrity from a normal Windows user terminal before desktop testing or delivery."}
$after=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash
if($before -ne $after){throw 'Executable content changed while validating its security label.'}
$file=Get-Item -LiteralPath $exe
[pscustomobject]@{Executable=$exe;Version=$file.VersionInfo.ProductVersion;Bytes=$file.Length;Integrity='Medium';IntegrityRid=$rid;SHA256=$after}
