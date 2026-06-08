Imports System

Public Class Greeter
  Public Property Name As String
  Public Sub SayHello()
    Console.WriteLine(Name)
  End Sub
  Public Shared Function Echo(value As String) As String
    Return value
  End Function
End Class
