Attribute VB_Name = "GreetingModule"
Option Explicit

Private counter As Long

Public Type Person
    Name As String
    Age As Integer
End Type

Public Enum GreetingStatus
    GreetingReady = 1
    GreetingFailed = 2
End Enum

Public Sub Initialize()
    counter = 0
    FormatGreeting "Ada"
End Sub

Public Function FormatGreeting(ByVal name As String) As String
    FormatGreeting = "Hello " & name
End Function
